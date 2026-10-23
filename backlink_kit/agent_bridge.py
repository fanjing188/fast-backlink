"""Agent CLI 与浏览器扩展之间的本机命令通道。

CLI 把动作写进本机服务；扩展后台用长轮询取走命令，在浏览器里执行后回传结果。
通道只存在于 127.0.0.1 的带令牌路由内，命令不落盘，进程重启即失效。
"""
from __future__ import annotations

from collections import deque
import threading
import time
import uuid

# 扩展能执行的动作；服务端先做白名单，避免本地通道变成任意脚本入口。
ACTIONS = {
    'status', 'tabs', 'open', 'fill', 'ai', 'restore', 'remember', 'snapshot', 'steps', 'state',
    'activate', 'done', 'skip',
}
MAX_WAIT_SECONDS = 180
MAX_POLL_SECONDS = 30
COMMAND_TTL_SECONDS = 300
CONNECTED_SECONDS = 60
POLLING_SECONDS = 45


def _now():
    return time.time()


class AgentBridge:
    def __init__(self):
        self._condition = threading.Condition()
        self._pending = deque()
        self._commands = {}
        self._last_seen = 0.0
        self._last_poll = 0.0
        self._version = ''

    # ---------- 扩展侧 ----------

    def touch(self, version=''):
        """任意扩展请求都算心跳；长轮询另外记 polling。"""
        with self._condition:
            self._last_seen = time.monotonic()
            if version:
                self._version = str(version)[:40]

    def next(self, wait=20, version=''):
        wait = max(0.0, min(float(wait or 0), MAX_POLL_SECONDS))
        with self._condition:
            self._last_seen = time.monotonic()
            self._last_poll = time.monotonic()
            if version:
                self._version = str(version)[:40]
            self._expire()
            deadline = time.monotonic() + wait
            while True:
                self._drop_cancelled()
                if self._pending:
                    ident = self._pending.popleft()
                    record = self._commands[ident]
                    if record['state'] != 'pending':
                        continue
                    record['state'] = 'running'
                    record['started_at'] = _now()
                    return {'id': ident, 'action': record['action'], 'args': record['args']}
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._condition.wait(timeout=remaining)

    def complete(self, ident, result=None, error=None):
        with self._condition:
            record = self._commands.get(ident)
            if record is None:
                raise ValueError('unknown_command')
            if record['state'] in ('done', 'error', 'cancelled'):
                return self.snapshot(ident)
            record.update(state='error' if error else 'done', result=result,
                          error=str(error)[:2000] if error else None, completed_at=_now())
            self._condition.notify_all()
            return self.snapshot(ident)

    # ---------- CLI 侧 ----------

    def submit(self, action, args, wait=60):
        if action not in ACTIONS:
            raise ValueError('unknown_action')
        if not isinstance(args, dict):
            raise ValueError('invalid_args')
        wait = max(0.0, min(float(wait or 0), MAX_WAIT_SECONDS))
        with self._condition:
            self._expire()
            ident = uuid.uuid4().hex
            self._commands[ident] = {
                'id': ident, 'action': action, 'args': args, 'state': 'pending',
                'result': None, 'error': None, 'created_at': _now(),
                'started_at': None, 'completed_at': None,
            }
            self._pending.append(ident)
            self._condition.notify_all()
            deadline = time.monotonic() + wait
            # 扩展取走后是 running，CLI 仍要等真正的回执。
            while self._commands[ident]['state'] in ('pending', 'running'):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._condition.wait(timeout=min(0.5, remaining))
            return self.snapshot(ident)

    def cancel(self, ident):
        with self._condition:
            record = self._commands.get(ident)
            if record is None:
                raise ValueError('unknown_command')
            if record['state'] == 'pending':
                record.update(state='cancelled', error='cancelled', completed_at=_now())
                self._condition.notify_all()
            return self.snapshot(ident)

    def snapshot(self, ident):
        record = self._commands.get(ident)
        if record is None:
            raise ValueError('unknown_command')
        return {key: record[key] for key in
                ('id', 'action', 'state', 'result', 'error', 'created_at', 'started_at', 'completed_at')}

    def status(self):
        with self._condition:
            self._expire()
            now = time.monotonic()
            seen = None if not self._last_seen else round(max(0.0, now - self._last_seen), 1)
            poll = None if not self._last_poll else round(max(0.0, now - self._last_poll), 1)
            active = sum(1 for record in self._commands.values()
                         if record['state'] in ('pending', 'running'))
            return {
                'connected': seen is not None and seen < CONNECTED_SECONDS,
                'polling': poll is not None and poll < POLLING_SECONDS,
                'last_seen_seconds': seen,
                'last_poll_seconds': poll,
                'version': self._version or None,
                'active_commands': active,
                'queued_commands': sum(1 for record in self._commands.values() if record['state'] == 'pending'),
            }

    # ---------- 内部 ----------

    def _drop_cancelled(self):
        while self._pending:
            ident = self._pending[0]
            state = self._commands.get(ident, {}).get('state')
            if state in ('pending', 'running'):
                break
            self._pending.popleft()

    def _expire(self):
        now = _now()
        changed = False
        for record in self._commands.values():
            if record['state'] in ('pending', 'running') and now - record['created_at'] > COMMAND_TTL_SECONDS:
                # 超时的命令绝不再交给扩展；CLI 已经离开时尤其不能晚点执行。
                record.update(state='error', error='command_expired', completed_at=now)
                changed = True
        if changed:
            self._condition.notify_all()
        self._drop_cancelled()
