"""同页扩展的数据接口；不调用浏览器，不执行提交。

0.1.x 只提供资料包文本、记忆和配方；1.0 增加 v2 素材（分档/多语言/媒体）、
快照落盘、日志入库、设置镜像、学习映射、任务队列，以及给 CDP 上传用的暂存路径。
"""
from __future__ import annotations
import json
import hashlib
import mimetypes
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from . import ai, kits, library
from .core import rules, sensitive, semantic_key, domain
from .fbstores import LearningStore, LogSink, SettingsStore, SnapshotStore
from .sources import SourceStore, apply_event, evidence, submitted

VERSION = '1.0.1'
# 只允许扩展下载这几类文件；视频走 CDP 暂存路径，不经过消息体。
SERVED_MIMES = ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml')
STAGE_TTL_SECONDS = 3600
LEARNED_RULES = Path(__file__).resolve().parents[1] / 'rules' / 'learned.json'


def clean_fields(items, default_key=None):
    result = []
    for item in items:
        if not isinstance(item, dict) or sensitive(item):
            continue
        label = str(item.get('label', '')).strip()[:500]
        if not label:
            continue
        field = {k: item[k] for k in ('inputType', 'role', 'required', 'maxlength', 'options', 'step', 'widget', 'locator') if k in item}
        field.update(label=label, key=semantic_key(item) or default_key or 'label')
        value = item.get('value')
        if (isinstance(value, (str, bool)) or isinstance(value, list) and all(isinstance(v, str) for v in value)) and field.get('inputType') != 'file':
            field['value'] = value
        result.append(field)
    return result


class ExtensionAPI:
    def __init__(self, conf, store):
        self.conf, self.store = conf, store
        self.library = SourceStore(conf['sources_dir'])
        self.snapshots = SnapshotStore(conf['snapshots_dir'])
        self.logs = LogSink(conf['logs_dir'])
        self.settings = SettingsStore(conf['settings_dir'])
        self.learning = LearningStore(conf.get('learned_file') or LEARNED_RULES)
        self.stage_root = Path(conf['stage_dir'])
        self.ai = ai.AIAdvisor(conf, logger=lambda entry: self.logs.append([entry]))

    # ---------- 素材 ----------

    def kit(self, site) -> dict:
        if site not in self.conf['sites']:
            raise ValueError('unknown_site')
        kit, _ = kits.load(self.conf, site)
        return kit

    def kit_payload(self, site):
        """给扩展的资料包：只有编号和文本，没有本机路径。"""
        kit = self.kit(site)
        profile = kits.profile(self.conf)
        assets = []
        for index, asset in enumerate(kit['assets']):
            try:
                _, asset_path = kits.resolve_asset(self.conf, site, str(index))
                digest = hashlib.sha256(asset_path.read_bytes()).hexdigest()
            except (OSError, ValueError):
                digest = None
            assets.append(dict(id=str(index), assetId=asset.get('id'), key=asset.get('key'),
                               sha256=digest,
                               mime=asset.get('mime'), w=asset.get('w'), h=asset.get('h'),
                               bytes=asset.get('bytes'), alt=asset.get('alt', ''),
                               name=Path(str(asset.get('file', ''))).name,
                               hint=kits.ASSET_RULES.get(asset.get('key'), {}).get('hint', '')))
        qa = dict(kits.QA_DEFAULTS)
        qa.update(profile.get('qa') or {})
        qa.update(kit.get('qa_overrides') or {})
        return dict(schema_version=kits.SCHEMA_VERSION, site=site, fields=kit['fields'], assets=assets,
                    qa=qa, qa_overrides=kit.get('qa_overrides') or {}, profile=profile.get('fields') or {},
                    missing=[key for key in kits.ASSET_RULES if not any(a.get('key') == key for a in kit['assets'])])

    def file(self, site, ident, sha256=None):
        asset, path = kits.resolve_asset(self.conf, site, ident)
        mime = asset.get('mime') or mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        if mime not in SERVED_MIMES:
            raise ValueError('image_only')
        raw = path.read_bytes()
        if sha256 and hashlib.sha256(raw).hexdigest() != sha256:
            raise ValueError('素材内容已变化，请重新确认')
        return raw, mime

    def stage(self, site, ident, sha256=None):
        """把素材复制到服务自管暂存目录，供 CDP 按路径上传（视频只能这样传）。"""
        asset, path = kits.resolve_asset(self.conf, site, ident)
        root = self.stage_root / 'assets'
        root.mkdir(parents=True, exist_ok=True)
        stamp = time.time()
        for old in root.glob('*'):
            try:
                if stamp - old.stat().st_mtime > STAGE_TTL_SECONDS:
                    old.unlink(missing_ok=True)
            except OSError:
                continue
        target = root / f'{int(stamp)}-{path.name}'
        shutil.copy2(path, target)
        if sha256 and hashlib.sha256(target.read_bytes()).hexdigest() != sha256:
            raise ValueError('素材内容已变化，请重新确认')
        return {'path': str(target), 'root': str(root), 'name': path.name, 'bytes': target.stat().st_size,
                'mime': asset.get('mime') or mimetypes.guess_type(path.name)[0]}

    # ---------- 上下文 ----------

    def context(self, site, url, record=None):
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('invalid_url')
        records = self.library.rows()
        exact = [r for r in records if any(u.split('#')[0].rstrip('/') == url.split('#')[0].rstrip('/') for u in r['submit_urls'])]
        if record:
            source = self.library.load(record['source_domain'])
        elif len(exact) == 1:
            source = exact[0]
        elif len(exact) > 1 or domain(url) in ('tally.so', 'forms.gle', 'docs.google.com', 'form.typeform.com'):
            raise ValueError('共享表单宿主无法唯一关联来源，请从续填列表打开')
        else:
            source = self.library.load(domain(url))
        recipe = source.get('recipe')
        if recipe:
            recipe = {**recipe, 'steps': [{**s, 'fields': clean_fields(s['fields'])} for s in recipe['steps']]}
        memory = source['memories'].get(site, {'fields': [], 'labels': {}})
        return dict(site=site, source_domain=source['domain'], submit_url=url,
                    submission_locked=submitted(source, site, library.history_rows(self.conf), include_in_progress=False),
                    record={k: record[k] for k in ('id', 'step', 'blocker', 'blocker_location', 'status') if k in record} if record else None,
                    fields=clean_fields(record.get('fields', [])) if record else [],
                    steps=[{'fields': clean_fields(s['fields'])} for s in record.get('steps', [])] if record else [],
                    kit=self.kit_payload(site),
                    assets=self.kit_payload(site)['assets'],
                    recipe=recipe,
                    memory={'fields': clean_fields(memory['fields']),
                            'labels': {k: v for k, v in memory['labels'].items() if not sensitive({'label': k, 'key': v})}},
                    settings=self.settings.get(),
                    auto_next=self.auto_next_for(source['domain']),
                    archive=record.get('archive') if record else None)

    def auto_next_for(self, source_domain):
        settings = self.settings.get()
        override = (settings.get('auto_next_sites') or {}).get(source_domain)
        return bool(settings.get('auto_next') if override is None else override)

    # ---------- 读 ----------

    def source_steps(self, site, url, source_domain):
        source = self.library.load(source_domain)
        return source['memories'].get(site, {'fields': [], 'labels': {}})

    def get(self, endpoint, query):
        if endpoint == 'batch_status':
            from .batch import BatchStore
            return BatchStore(self.conf).status(query.get('id'))
        if endpoint == 'library_template':
            return {'csv': 'url,type,fee,note\nhttps://example.com/submit,directory,free,\n'}
        if endpoint == 'library':
            return library.listing(self.conf, query)
        if endpoint == 'health':
            return {'name': 'fast-backlink', 'version': VERSION, 'schema_version': kits.SCHEMA_VERSION}
        if endpoint == 'rules':
            # fieldRules 是匹配分层第 5 层的加权同义词/排他词表；没有它扩展只能退回旧的 labels.json。
            return dict(labels=rules('labels'), sensitive=rules('keywords')['sensitive'],
                        navigation=rules('navigation'), learned=self.learning.mapping(),
                        fieldRules=rules('field-rules'))
        if endpoint == 'sites':
            return list(self.conf['sites'])
        if endpoint == 'kits':
            return [kits.kit_summary(self.conf, site) for site in self.conf['sites']]
        if endpoint == 'kit':
            return self.kit_payload(query['site'])
        if endpoint == 'profile':
            return kits.profile(self.conf)
        if endpoint == 'item':
            r = next((r for r in self.store.rows() if r['id'] == query['id']), None)
            if not r or r['status'] not in ('待处理', '待授权', '待人工'):
                raise ValueError('当前项需人工核对或重新备料')
            return self.context(r['site'], r['submit_url'], r)
        if endpoint == 'source':
            return self.context(query['site'], query['url'])
        if endpoint == 'queue':
            rows = [r for r in self.store.rows() if r['status'] in ('待处理', '待授权', '待人工')]
            if query.get('site'):
                rows = [r for r in rows if r['site'] == query['site']]
            return [{'id': r['id'], 'site': r['site'], 'source_domain': r['source_domain'],
                     'submit_url': r['submit_url'], 'status': r['status'],
                     'archive': {k: v for k, v in r.get('archive', {}).items() if k != 'frames'},
                     'blocker': r.get('blocker', ''), 'step': r.get('step', 0)} for r in rows]
        if endpoint == 'snapshots':
            return self.snapshots.list(source_domain=query.get('source'), site=query.get('site'),
                                       url=query.get('url'), form_fingerprint=query.get('fingerprint'),
                                       limit=int(query.get('limit') or 20))
        if endpoint == 'snapshot':
            return self.snapshots.load(query['id'])
        if endpoint == 'logs':
            return self.logs.read(days=int(query.get('days') or 7), level=query.get('level'),
                                  cat=query.get('cat'), site=query.get('site'), source=query.get('source'),
                                  limit=int(query.get('limit') or 500))
        if endpoint == 'settings':
            return self.settings.get()
        if endpoint == 'ai':
            return self.ai.status()
        if endpoint == 'report':
            from .fbreport import build
            report, count = build(self.logs.root, days=int(query.get('days') or 7))
            return {'entries': count, **report}
        raise ValueError('invalid_endpoint')

    # ---------- 写 ----------

    def remember(self, context, data):
        steps = []
        values = []
        for index, step in enumerate(data.get('steps', [])):
            fields = clean_fields(step.get('fields', []))
            steps.append({'fields': fields})
            values.extend({**f, 'step': index} for f in fields if f.get('value') not in (None, '', []))
        if not steps or not any(s['fields'] for s in steps):
            raise ValueError('没有可记住的非敏感字段')
        proof = evidence('extension:manual', by='manual')
        with self.library.lock():
            source = self.library.load(context['source_domain'])
            apply_event(source, 'capture', {'url': context['submit_url'], 'steps': steps, 'coverage': {'complete': bool(data.get('complete'))}}, proof)
            apply_event(source, 'memory', values, proof, context['site'])
            # 人工录制确认当前结构；未见过的后续步骤不声称完整。
            source['recipe']['state'] = '已记录'
            atomic_write(self.library.root / (source['domain'] + '.json'), source)
            self.library.index()
        learned = []
        for item in values:
            label = str(item.get('label', '')).strip()
            key = semantic_key(item) or item.get('key')
            if label and key and key != 'label':
                learned.append(self.learning.observe(label, key, context['source_domain'], context['site']))
        return {'remembered': len(values), 'learned': [x for x in learned if x]}

    def save_snapshot(self, data):
        if not isinstance(data, dict) or not isinstance(data.get('steps'), list):
            raise ValueError('invalid_snapshot')
        if len(json.dumps(data, ensure_ascii=False)) > 2_000_000:
            raise ValueError('snapshot_too_large')
        from .archives import clean_frame
        clean = clean_frame(data, data.get('site', ''), data.get('source_domain', ''))
        data = {**data, 'steps': clean['steps']}
        path = self.snapshots.save(data)
        return {'saved': path, 'id': data.get('id')}

    def upload_logs(self, data):
        entries = data.get('entries')
        written = self.logs.append(entries)
        return {'written': written}

    def post(self, endpoint, data):
        if endpoint in ('library_import_preview', 'library_import', 'library_export', 'library_bulk'):
            from . import library_v2 as v2
            if endpoint.startswith('library_import'):
                return v2.import_file(self.conf, data, confirm=endpoint == 'library_import')
            if endpoint == 'library_export':
                return {'csv': v2.csv_text(v2.export_rows(self.conf, data))}
            return v2.bulk(self.conf, data)
        if endpoint.startswith('batch_'):
            from .batch import BatchStore
            store = BatchStore(self.conf)
            actions = {'batch_preview': store.preview, 'batch_start': store.start, 'batch_claim': store.claim,
                       'batch_control': store.control, 'batch_attempt': store.attempt, 'batch_result': store.result,
                       'batch_resolve': lambda data: store.result(data, manual=True)}
            if endpoint not in actions:
                raise ValueError('invalid_endpoint')
            return actions[endpoint](data)
        if endpoint == 'library_prepare':
            return library.prepare(self.conf, data)
        if endpoint == 'library':
            return library.save(self.conf, data)
        if endpoint == 'archive':
            from .archives import save
            return save(self, data)
        if endpoint == 'ai_suggest':
            return self.ai.suggest(data)
        if endpoint == 'ai_config':
            return ai.configure(self.conf, data, save=True)
        if endpoint == 'ai_test':
            return ai.test_connection(self.conf, data)
        if endpoint == 'auth_suggest':
            from .auth_ai import suggest
            return suggest(self.ai, data)
        if endpoint == 'snapshot':
            return self.save_snapshot(data)
        if endpoint == 'logs':
            return self.upload_logs(data)
        if endpoint == 'settings':
            return self.settings.put(data.get('patch') or data.get('settings') or {})
        if endpoint == 'learn':
            label, key = str(data.get('label', '')).strip(), data.get('key')
            if not label or not key:
                raise ValueError('invalid_learning')
            promoted = self.learning.observe(label, key, data.get('source', ''), data.get('site', ''))
            return {'promoted': promoted, 'label': label, 'key': key}
        if endpoint == 'kit':
            site = data.get('site')
            if site not in self.conf['sites']:
                raise ValueError('unknown_site')
            incoming = data.get('kit') or {}
            if not isinstance(incoming, dict):
                raise ValueError('invalid_kit')
            if incoming.get('site') and incoming['site'] != site:
                raise ValueError('kit_site_mismatch：资料包属于其他产品，请选择对应项目')
            original = kits.load(self.conf, site, resolve_paths=False)[0]
            incoming = dict(incoming)
            incoming.setdefault('qa_overrides', original.get('qa_overrides') or {})
            incoming.setdefault('assets', original['assets'])
            registered = {asset['id']: asset for asset in original['assets']}
            assets = []
            for asset in incoming['assets']:
                if 'assetId' not in asset:
                    assets.append(asset)
                    continue
                saved = registered.get(asset['assetId'])
                if not saved:
                    raise ValueError('stale_asset：素材登记已变化，请重新读取资料包')
                # 展示序号不是持久ID；编辑只更新alt，不覆盖文件位置与素材身份。
                assets.append({**saved, 'alt': asset.get('alt', saved.get('alt', ''))})
            incoming['assets'] = assets
            kit = kits.normalize(incoming, site)
            kits.save(self.conf, site, kit)
            errors, warnings = kits.check(kits.load(self.conf, site)[0], kits.kit_dir(self.conf, site), kits.profile(self.conf))
            return {'saved': site, 'errors': errors, 'warnings': warnings}
        if endpoint == 'profile':
            saved = kits.save_profile(self.conf, data.get('profile') or {})
            return {'saved': 'profile', 'fields': sorted((saved.get('fields') or {}).keys())}
        if endpoint == 'asset':
            return self.save_asset(data)
        ident = data.get('id')
        if not ident:
            if endpoint != 'remember':
                raise ValueError('请从续填列表打开后操作')
            return self.remember(self.context(data['site'], data['url']), data)
        if endpoint == 'submission-attempt':
            from .handoff import stamp
            from .sources import source_event
            record = self.store.load(ident)
            if record.get('batch_id'):
                from .batch import BatchStore
                return BatchStore(self.conf).manual_attempt(record['batch_id'], ident)
            # 只等待本地状态写锁，不重发网页投稿；短暂results写入不能吞掉提交事实。
            with self.store.lock(ident, timeout=2):
                r = self.store.load(ident)
                if r['status'] in ('待核实', '结果未知'):
                    return {'status': r['status']}
                r.update(status='结果未知', attempted_at=stamp(), message='检测到人工提交；先核实收稿结果，禁止重放')
                self.store.save(r)
                source_event(self.conf, r['source_domain'], 'history', r, self.store.path(ident))
                return {'status': r['status']}
        if endpoint in ('done', 'skip'):
            # done 的记忆和状态更新在同一项锁内，复用原有回执与历史逻辑。
            return self.store.transition(ident, endpoint, self.conf['runs_dir'], data.get('reason', ''), extension_data=data, extension_api=self)
        with self.store.lock(ident):
            r = self.store.load(ident)
            if r.get('batch_id') and endpoint == 'results':
                return {'status': r['status']}
            if r['status'] not in ('待处理', '待授权', '待人工'):
                raise ValueError('当前状态不允许扩展写入')
            if endpoint == 'remember':
                return self.remember(self.context(r['site'], r['submit_url'], r), data)
            if endpoint != 'results':
                raise ValueError('invalid_endpoint')
            r['results'] = [dict(label=f['label'], status=f['status'], key=f.get('key'), conf=f.get('conf'))
                            for f in data.get('results', [])
                            if isinstance(f, dict) and not sensitive(f) and isinstance(f.get('label'), str)
                            and f.get('status') in ('filled', 'unmatched', 'skipped', 'confirm')
                            and (f.get('conf') is None or isinstance(f.get('conf'), (int, float)))]
            r.update(status='待人工', message='扩展同页填写；人工处理剩余项并自行提交')
            self.store.save(r)
            return {'status': r['status']}

    def save_asset(self, data):
        """素材库管理页上传：base64 写入 <kits>/<site>/assets/ 并登记。"""
        import base64
        site, key = data.get('site'), data.get('key')
        if site not in self.conf['sites'] or key not in kits.ASSET_RULES:
            raise ValueError('unknown_asset_target')
        raw = base64.b64decode(data.get('data') or '', validate=True)
        if not raw or len(raw) > 16_000_000:
            raise ValueError('bad_asset_bytes')
        name = Path(str(data.get('name') or f'{key}.png')).name
        if not name or '/' in name:
            raise ValueError('bad_asset_name')
        directory = kits.kit_dir(self.conf, site) / 'assets'
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / name
        target.write_bytes(raw)
        kit, _ = kits.load(self.conf, site)
        record = kits.asset_record(target, key, ident=Path(name).stem, alt=str(data.get('alt') or ''))
        kit['assets'] = [a for a in kit['assets'] if a.get('id') != record['id']] + [record]
        kits.save(self.conf, site, kit)
        errors, warnings = kits.check(kit, kits.kit_dir(self.conf, site), kits.profile(self.conf))
        return {'asset': record, 'errors': errors, 'warnings': warnings}


def atomic_write(path, obj):
    from .core import atomic_json
    atomic_json(path, obj)
