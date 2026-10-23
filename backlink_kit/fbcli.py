"""Fast-Backlink 的标准命令行接口；给 Agent 用，默认输出 JSON。

命令走本机服务的带令牌路由：数据命令直接读服务，页面命令经 command bridge
交给扩展后台执行。所有输出只有一份 JSON，令牌和本机路径不回显。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_SERVICE = 3
EXIT_EXTENSION = 4
EXIT_TIMEOUT = 5

SERVICE_ENV = 'BK_HANDOFF_URL'
TOKEN_ENV = 'BK_HANDOFF_TOKEN_FILE'
DEFAULT_TOKEN_FILE = '~/.config/backlink-kit/handoff-token'
DEFAULT_PORT = 18780

# 不需要页面、可直接从本机服务读的动作；fb call 也复用这张表。
DIRECT_ACTIONS = {
    'health', 'sites', 'kits', 'queue', 'logs', 'report', 'snapshots', 'settings', 'profile',
}
PAGE_ACTIONS = {
    'status', 'tabs', 'open', 'fill', 'ai', 'restore', 'remember', 'snapshot', 'steps', 'state',
    'activate', 'done', 'skip', 'batch',
}


class CLIError(Exception):
    def __init__(self, code, error, message='', **extra):
        super().__init__(message or error)
        self.code = code
        self.payload = {'ok': False, 'error': error}
        if message:
            self.payload['message'] = message
        self.payload.update({key: value for key, value in extra.items() if value is not None})


class Service:
    def __init__(self, conf, url=None):
        self.base = self._resolve(conf, url)
        parts = urlsplit(self.base)
        self.display = {'host': parts.hostname, 'port': parts.port}

    @staticmethod
    def _valid(candidate):
        if not candidate:
            return None
        candidate = str(candidate).rstrip('/') + '/'
        parts = urlsplit(candidate)
        try:
            port = parts.port
        except ValueError:
            return None
        if parts.scheme != 'http' or parts.hostname != '127.0.0.1' or not port:
            return None
        if not re.fullmatch(r'[\w-]{32,}', parts.path.strip('/')):
            return None
        return candidate

    @classmethod
    def _resolve(cls, conf, url=None):
        candidates = [url, os.environ.get(SERVICE_ENV)]
        info = Path(conf.get('handoff_dir', '')) / 'server.json'
        if info.is_file():
            try:
                candidates.append(json.loads(info.read_text()).get('url'))
            except (OSError, ValueError):
                pass
        token_file = Path(os.environ.get(TOKEN_ENV, DEFAULT_TOKEN_FILE)).expanduser()
        try:
            token = token_file.read_text().strip() if token_file.is_file() else ''
        except OSError:
            token = ''
        if len(token) >= 32:
            candidates.append(f'http://127.0.0.1:{DEFAULT_PORT}/{token}/')
        for candidate in candidates:
            valid = cls._valid(candidate)
            if valid:
                return valid
        raise CLIError(EXIT_SERVICE, 'service_url_unknown',
                       '找不到本机服务地址；先启动 handoff serve',
                       hint='python3 bk.py handoff serve --port 18780 --token-file ~/.config/backlink-kit/handoff-token')

    def request(self, endpoint, query=None, data=None, timeout=15):
        url = self.base + 'api/' + endpoint
        if query:
            clean = {key: value for key, value in query.items() if value is not None}
            if clean:
                url += '?' + urlencode(clean)
        headers = {'X-Fast-Backlink': '1'}
        body = None
        if data is not None:
            body = json.dumps(data, ensure_ascii=False).encode()
            headers['Content-Type'] = 'application/json'
        request = Request(url, data=body, headers=headers, method='POST' if data is not None else 'GET')
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read()
        except HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode())
            except (ValueError, OSError):
                payload = {}
            raise CLIError(EXIT_FAILED, 'service_rejected', str(payload.get('error') or f'HTTP {exc.code}'),
                           status=exc.code) from None
        except (URLError, socket.timeout, TimeoutError) as exc:
            reason = getattr(exc, 'reason', exc)
            raise CLIError(EXIT_SERVICE, 'service_unavailable', '本机服务不可达：' + str(reason),
                           hint='python3 bk.py handoff serve --port 18780 --token-file ~/.config/backlink-kit/handoff-token') from None
        try:
            return json.loads(raw or b'null')
        except ValueError:
            raise CLIError(EXIT_FAILED, 'invalid_response', '本机服务返回的不是 JSON') from None

    def get(self, endpoint, **query):
        return self.request(endpoint, query=query)

    def post(self, endpoint, data, timeout=15):
        return self.request(endpoint, data=data, timeout=timeout)


def _agent(service, action, args, wait, status=None):
    """提交一条扩展命令；超时就取消，绝不让它晚点偷偷执行。"""
    wait = max(0.0, min(float(wait or 60), 180))
    status = status or service.get('agent/status')
    connected = bool(status.get('connected'))
    # 扩展休眠时 alarms 最多 30 秒叫醒；没连接过就尽早失败，别让 Agent 干等。
    effective = wait if connected or status.get('last_seen_seconds') is not None else min(wait, 10)
    reply = service.post('agent/command', {'action': action, 'args': args or {}, 'wait': effective},
                         timeout=effective + 20)
    state = reply.get('state')
    if state == 'done':
        return reply.get('result') or {}, reply
    if state == 'error':
        raise CLIError(EXIT_FAILED, 'command_failed', reply.get('error') or '扩展执行失败', command=reply)
    if state == 'pending':
        try:
            service.post('agent/cancel', {'id': reply.get('id')}, timeout=5)
        except CLIError:
            pass
        if not connected:
            raise CLIError(EXIT_EXTENSION, 'extension_unavailable', 'Fast-Backlink 扩展没有响应',
                           hint='在 Edge 打开扩展选项，确认续填列表地址；扩展每 30 秒自动重连',
                           extension=status, command=reply)
        raise CLIError(EXIT_TIMEOUT, 'command_timeout', '扩展在等待时间内没有执行完',
                       hint='加大 --wait，或先运行 fb status 查看连接与当前标签页', command=reply)
    raise CLIError(EXIT_FAILED, 'invalid_response', '扩展返回了未知状态：' + str(state), command=reply)


def _args_from(args):
    if getattr(args, 'args_file', None):
        return json.loads(Path(args.args_file).read_text())
    if getattr(args, 'args', None):
        return json.loads(args.args)
    return {}


def _tab_args(args):
    return {'tabId': getattr(args, 'tab', None), 'url': getattr(args, 'url', None)}


def _json_value(raw):
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def run(args, conf):
    service = Service(conf, getattr(args, 'service', None))
    pretty = bool(getattr(args, 'pretty', False))
    action = args.fb_action

    def emit(payload):
        print(json.dumps(payload, ensure_ascii=False, indent=2 if pretty else None,
                         separators=None if pretty else (',', ':')))
        return EXIT_OK

    def page(name, payload, wait=None):
        result, command = _agent(service, name, payload, wait if wait is not None else getattr(args, 'wait', 60))
        return emit({'ok': True, 'action': name, 'command_id': command.get('id'), **result})

    if action == 'batch':
        payload = {'action': args.batch_action}
        if args.batch_action == 'start':
            payload.update(site=args.site, domains=[d.strip() for d in args.domains.split(',') if d.strip()], batch_size=args.batch_size)
        elif getattr(args, 'id', None):
            payload['id'] = args.id
        return page('batch', payload)

    if action == 'status':
        status = service.get('agent/status')
        active = None
        active_error = None
        if status.get('connected'):
            try:
                result, _ = _agent(service, 'status', {}, min(getattr(args, 'wait', 5), 5), status)
                active = result
            except CLIError as exc:
                active_error = exc.payload
            # 首次心跳可先于长轮询版本登记；页面命令完成后读取同一时点的连接状态。
            status = service.get('agent/status')
        return emit({'ok': True, 'service': {**service.display, 'connected': True},
                     'extension': status, 'active': active, 'active_error': active_error})

    if action == 'tabs':
        result, command = _agent(service, 'tabs', {}, getattr(args, 'wait', 10))
        return emit({'ok': True, 'action': 'tabs', 'command_id': command.get('id'), **result})

    if action == 'open':
        item = service.get('item', id=args.item) if args.item else None
        url = args.url or (item or {}).get('submit_url')
        if not url:
            raise CLIError(EXIT_USAGE, 'missing_url', 'open 需要 URL，或用 --item 指定续填项')
        payload = {'url': url, 'site': args.site or (item or {}).get('site'), 'item': args.item,
                   'fill': not args.no_fill, 'force': bool(args.force)}
        return page('open', payload)

    if action == 'fill':
        payload = {**_tab_args(args), 'site': args.site, 'item': args.item,
                   'force': bool(args.force), 'open': bool(args.open)}
        return page('fill', payload)

    if action == 'ai':
        payload = {**_tab_args(args), 'site': args.site, 'item': args.item, 'open': bool(args.open),
                   'apply': bool(args.apply), 'minConf': args.min_conf}
        return page('ai', payload, getattr(args, 'wait', 90))

    if action == 'restore':
        snapshot = None
        if args.snapshot:
            raw = Path(args.snapshot).read_text()
            if len(raw) > 4_000_000:
                raise CLIError(EXIT_USAGE, 'snapshot_too_large', '快照超过 4MB，无法通过命令通道发送')
            snapshot = json.loads(raw)
        return page('restore', {**_tab_args(args), 'snapshot': snapshot})

    if action == 'remember':
        return page('remember', _tab_args(args))

    if action == 'snapshot':
        result, command = _agent(service, 'snapshot', _tab_args(args), getattr(args, 'wait', 60))
        if args.output:
            snapshot = result.get('snapshot') or {}
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2))
            steps = snapshot.get('steps') or []
            index = snapshot.get('step_index') or 0
            fields = steps[index].get('fields', []) if 0 <= index < len(steps) else []
            return emit({'ok': True, 'action': 'snapshot', 'command_id': command.get('id'),
                         'tab': result.get('tab'), 'snapshot_path': str(output), 'fields': len(fields)})
        return emit({'ok': True, 'action': 'snapshot', 'command_id': command.get('id'), **result})

    if action == 'steps':
        return page('steps', _tab_args(args), getattr(args, 'wait', 30))

    if action == 'state':
        return page('state', _tab_args(args), getattr(args, 'wait', 30))

    if action == 'done':
        payload = {**_tab_args(args), 'id': args.id, 'open': bool(args.open)}
        if args.steps:
            payload['steps'] = json.loads(Path(args.steps).read_text())
        return page('done', payload)

    if action == 'skip':
        result = service.post('skip', {'id': args.id, 'reason': args.reason})
        return emit({'ok': True, 'action': 'skip', 'item': result})

    if action == 'queue':
        rows = service.get('queue', site=args.site)
        return emit({'ok': True, 'queue': rows, 'count': len(rows)})

    if action == 'sites':
        rows = service.get('sites')
        return emit({'ok': True, 'sites': rows, 'count': len(rows)})

    if action == 'kits':
        rows = service.get('kits')
        return emit({'ok': True, 'kits': rows, 'count': len(rows)})

    if action == 'health':
        return emit({'ok': True, 'health': service.get('health')})

    if action == 'snapshots':
        rows = service.get('snapshots', source=args.source, url=args.url,
                           fingerprint=args.fingerprint, limit=args.limit)
        return emit({'ok': True, 'snapshots': rows, 'count': len(rows)})

    if action == 'logs':
        rows = service.get('logs', days=args.days, level=args.level, cat=args.cat,
                           site=args.site, source=args.source, limit=args.limit)
        return emit({'ok': True, 'entries': rows, 'count': len(rows)})

    if action == 'report':
        return emit({'ok': True, 'report': service.get('report', days=args.days)})

    if action == 'settings':
        if args.patch or args.set:
            patch = json.loads(args.patch) if args.patch else {}
            for item in args.set:
                key, separator, value = item.partition('=')
                if not separator or not key:
                    raise CLIError(EXIT_USAGE, 'invalid_setting', '--set 需要 key=value：' + item)
                patch[key] = _json_value(value)
            return emit({'ok': True, 'settings': service.post('settings', {'patch': patch})})
        return emit({'ok': True, 'settings': service.get('settings')})

    if action == 'cancel':
        return emit({'ok': True, 'command': service.post('agent/cancel', {'id': args.id})})

    if action == 'call':
        name = args.call_action
        payload = _args_from(args)
        if getattr(args, 'tab', None) is not None:
            payload.setdefault('tabId', args.tab)
        if getattr(args, 'url', None):
            payload.setdefault('url', args.url)
        if name in DIRECT_ACTIONS:
            if name == 'settings':
                patch = dict(payload.get('patch') or {}) if isinstance(payload.get('patch'), dict) else {}
                if getattr(args, 'set', None) or getattr(args, 'patch', None) or patch:
                    if getattr(args, 'patch', None):
                        patch.update(json.loads(args.patch))
                    for item in getattr(args, 'set', []) or []:
                        key, separator, value = item.partition('=')
                        if not separator or not key:
                            raise CLIError(EXIT_USAGE, 'invalid_setting', '--set 需要 key=value：' + item)
                        patch[key] = _json_value(value)
                    return emit({'ok': True, name: service.post('settings', {'patch': patch})})
                return emit({'ok': True, name: service.get('settings')})
            rows = service.get(name, **payload)
            if isinstance(rows, list):
                return emit({'ok': True, name: rows, 'count': len(rows)})
            return emit({'ok': True, name: rows})
        if name == 'skip':
            result = service.post('skip', {'id': payload.get('id'), 'reason': payload.get('reason')})
            return emit({'ok': True, 'action': 'skip', 'item': result})
        if name not in PAGE_ACTIONS:
            raise CLIError(EXIT_USAGE, 'unknown_action', '未知动作：' + name,
                           hint='可用：' + ', '.join(sorted(DIRECT_ACTIONS | PAGE_ACTIONS)))
        return page(name, payload)

    raise CLIError(EXIT_USAGE, 'unknown_action', '未知 fb 子命令：' + action)
