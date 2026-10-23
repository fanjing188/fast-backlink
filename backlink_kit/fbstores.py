"""Fast-Backlink 的本机侧存储：快照、日志、设置镜像、学习到的映射。

扩展是快照的第一现场（IndexedDB），这里落盘保证浏览器崩溃、换浏览器也能取回；
Hermes 和命令行工具读同一份文件，不另建格式。
"""
from __future__ import annotations
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .core import atomic_json, domain, today

STAMP = '%Y-%m-%dT%H-%M-%S'
CATEGORIES = ('scan', 'match', 'ai', 'fill', 'verify', 'upload', 'snapshot', 'restore', 'captcha',
              'user', 'service', 'error', 'perf', 'auto-next')
LEVELS = ('debug', 'info', 'warn', 'error')


def now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def safe_name(value, limit=64):
    cleaned = re.sub(r'[^A-Za-z0-9._-]+', '-', str(value or '')).strip('-')
    return cleaned[:limit] or 'unknown'


class SnapshotStore:
    """每个来源域名一个目录；一个表单指纹保留最近 N 版、M 天。"""

    def __init__(self, root, keep=5, days=14):
        self.root = Path(root)
        self.keep, self.days = keep, days

    def path_for(self, snapshot):
        stamp = str(snapshot.get('created_at') or now_iso())[:19].replace(':', '-')
        name = f'{stamp}-{safe_name(snapshot.get("id"), 12)}.json'
        return self.root / safe_name(snapshot.get('source_domain') or domain(snapshot.get('url', '')), 120) / name

    def save(self, snapshot):
        item = dict(snapshot)
        item.setdefault('created_at', now_iso())
        item.setdefault('id', re.sub(r'\W', '', item['created_at'])[:20])
        path = self.path_for(item)
        atomic_json(path, item)
        self.prune(item.get('source_domain'), item.get('form_fingerprint'))
        return str(path)

    def files(self):
        if not self.root.exists():
            return []
        return sorted((p for p in self.root.glob('*/*.json') if not p.name.startswith('.')), reverse=True)

    def list(self, source_domain=None, site=None, url=None, form_fingerprint=None, limit=20):
        wanted = domain(source_domain or '') if source_domain else None
        result = []
        for path in self.files():
            if wanted and path.parent.name != wanted:
                continue
            try:
                item = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            item['path'] = str(path)
            if site and item.get('site') != site:
                continue
            if url and str(item.get('url', '')).split('#')[0] != str(url).split('#')[0]:
                continue
            if form_fingerprint and item.get('form_fingerprint') != form_fingerprint:
                continue
            result.append(item)
            if len(result) >= limit:
                break
        return result

    def load(self, ident):
        for path in self.files():
            if ident in path.name or ident == json.loads(path.read_text()).get('id'):
                item = json.loads(path.read_text())
                item['path'] = str(path)
                return item
        raise ValueError('snapshot_not_found')

    def prune(self, source_domain=None, form_fingerprint=None):
        wanted = domain(source_domain or '') if source_domain else None
        removed = []
        cutoff = datetime.now() - timedelta(days=self.days)
        grouped = {}
        for path in self.files():
            if wanted and path.parent.name != wanted:
                continue
            try:
                item = json.loads(path.read_text())
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
                removed.append(str(path))
                continue
            old = False
            try:
                old = datetime.fromisoformat(str(item.get('created_at', '')).replace('Z', '+00:00')).replace(tzinfo=None) < cutoff
            except ValueError:
                pass
            if old:
                path.unlink(missing_ok=True)
                removed.append(str(path))
                continue
            if form_fingerprint and item.get('form_fingerprint') not in (form_fingerprint, None):
                continue
            grouped.setdefault((path.parent.name, item.get('form_fingerprint') or '', item.get('url', '')), []).append(path)
        for paths in grouped.values():
            for path in paths[self.keep:]:
                path.unlink(missing_ok=True)
                removed.append(str(path))
        return removed


class LogSink:
    """按天写 JSONL；Claude/Codex/Hermes 可直接读。"""

    def __init__(self, root):
        self.root = Path(root)

    def day_file(self, stamp=None):
        day = str(stamp or now_iso())[:10]
        return self.root / f'{day}.jsonl'

    def append(self, entries):
        if not isinstance(entries, list) or not entries:
            raise ValueError('empty_log_batch')
        if len(entries) > 2000:
            raise ValueError('log_batch_too_large')
        written = 0
        by_day = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            by_day.setdefault(str(entry.get('ts') or now_iso())[:10], []).append(entry)
        for day, items in by_day.items():
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
                day = today().isoformat()
            path = self.root / f'{day}.jsonl'
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('a', encoding='utf-8') as handle:
                for item in items:
                    handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + '\n')
                    written += 1
        return written

    def files(self, days=7):
        if not self.root.exists():
            return []
        cutoff = today() - timedelta(days=days)
        result = []
        for path in sorted(self.root.glob('*.jsonl')):
            try:
                if datetime.strptime(path.stem, '%Y-%m-%d').date() < cutoff:
                    continue
            except ValueError:
                continue
            result.append(path)
        return result

    def read(self, days=7, level=None, cat=None, site=None, source=None, limit=500):
        result = []
        for path in self.files(days):
            for line in path.read_text(encoding='utf-8').splitlines():
                if not line.strip():
                    continue
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if level and item.get('level') != level:
                    continue
                if cat and item.get('cat') != cat:
                    continue
                if site and item.get('site') != site:
                    continue
                if source and item.get('source') != source:
                    continue
                result.append(item)
        return result[-limit:]


class SettingsStore:
    """扩展设置的镜像；写文件便于自动化和人工核对。"""

    DEFAULTS = {
        'restore_after_reload': True,
        'restore_after_submit_error': True,
        'restore_window_hours': 2,
        'auto_next': False,
        'auto_next_sites': {},
        'fill_low_confidence': True,
        'inline_asset_button': True,
        'floating_window': True,
        'ai_fallback': True,
        'snapshot_keep': 5,
        'snapshot_days': 14,
        'log_level': 'info',
    }

    def __init__(self, root):
        self.path = Path(root) / 'fast-backlink.json'

    def get(self):
        data = dict(self.DEFAULTS)
        if self.path.exists():
            stored = json.loads(self.path.read_text())
            for key, value in stored.items():
                if isinstance(value, dict) and isinstance(data.get(key), dict):
                    data[key].update(value)
                else:
                    data[key] = value
        return data

    def put(self, patch):
        if not isinstance(patch, dict):
            raise ValueError('invalid_settings')
        unknown = set(patch) - set(self.DEFAULTS)
        if unknown:
            raise ValueError('unknown_settings: ' + ','.join(sorted(unknown)))
        data = self.get()
        for key, value in patch.items():
            if isinstance(data.get(key), dict) and isinstance(value, dict):
                data[key].update(value)
            else:
                data[key] = value
        atomic_json(self.path, data)
        return data


class LearningStore:
    """同一标签在 ≥3 个不同来源被人工映射到同一 key，升为全局规则。"""

    PROMOTE_AT = 3

    def __init__(self, path):
        self.path = Path(path)

    def load(self):
        if not self.path.exists():
            return {'schema_version': 1, 'labels': {}, 'observations': {}}
        data = json.loads(self.path.read_text())
        data.setdefault('labels', {})
        data.setdefault('observations', {})
        return data

    def rebuild(self, sources_dir):
        """从 385 个来源记忆重算；不依赖扩展是否在线。"""
        observations = {}
        root = Path(sources_dir)
        for path in sorted(root.glob('*.json')):
            try:
                source = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            source_domain = source.get('domain') or path.stem
            for site, memory in (source.get('memories') or {}).items():
                for item in memory.get('fields') or []:
                    label, key = str(item.get('label', '')).strip(), item.get('key')
                    if not label or not key or key == 'label':
                        continue
                    bucket = observations.setdefault(label.lower(), {})
                    bucket.setdefault(key, set()).add(f'{source_domain}#{site}')
        data = {'schema_version': 1, 'labels': {}, 'observations': {}}
        for label, keys in observations.items():
            ranked = sorted(keys.items(), key=lambda kv: (-len(kv[1]), kv[0]))
            winner, by = ranked[0]
            # 观察记录和增量写入保持同一形状：{key: [来源#站点, ...]}。
            data['observations'][label] = {key: sorted(value) for key, value in ranked}
            if len(by) >= self.PROMOTE_AT:
                data['labels'][label] = {'key': winner, 'sources': len(by), 'updated_at': now_iso()}
        atomic_json(self.path, data)
        return data

    def observe(self, label, key, source_domain, site=''):
        """单次人工映射；跨来源计数达到阈值才提升。"""
        label = str(label or '').strip().lower()
        if not label or not key or key == 'label':
            return None
        data = self.load()
        bucket = data.setdefault('observations', {}).setdefault(label, {})
        keys = bucket.setdefault(key, [])
        token = f'{domain(source_domain)}#{site}'
        if token not in keys:
            keys.append(token)
        if len(keys) >= self.PROMOTE_AT:
            data['labels'][label] = {'key': key, 'sources': len(keys), 'updated_at': now_iso()}
        atomic_json(self.path, data)
        return data['labels'].get(label)

    def mapping(self):
        return {label: item['key'] for label, item in self.load()['labels'].items()}
