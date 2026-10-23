"""来源档案、离线导入和活动备料；文件访问之外不产生外部动作。"""
from contextlib import contextmanager
from copy import deepcopy
import fcntl
import hashlib
import json
from pathlib import Path
import re

from .core import (atomic_json, domain, today, day, read_csv, output_csv,
                   snapshot_fields, unwrap, semantic_key, sensitive, fillplan, fresh_dr, rules)

STATUSES = ('可投', '待核实', '待饼哥', '需批准', '不做')
EXCLUDED = set(rules('policy')['queue_exclude']) | {'待核实', '结果未知', '续填中'}


def unique(values):
    return list(dict.fromkeys(values))


def new_source(name):
    name = domain(name)
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', name) or '..' in name:
        raise ValueError('invalid_source_domain')
    return dict(schema_version=1, domain=name, submit_urls=[], form_hosts=[], basic={},
                admission={}, gates={}, recipe=None, recipe_versions=[], memories={},
                history=[], evidence=[], blockers=[])


def evidence(path, quote='', checked_at=None, by='tool'):
    return dict(path=str(path), quote=str(quote), checked_at=str(checked_at or today()), by=by)


def claim(value, proof):
    return dict(value=value, by=proof['by'], checked_at=proof['checked_at'], evidence=[proof])


def merge_claim(old, incoming):
    if not incoming:
        return deepcopy(old)
    if not old:
        return deepcopy(incoming)
    proofs = old.get('evidence', []) + incoming.get('evidence', [])
    proofs = list({json.dumps(x, sort_keys=True): x for x in proofs}.values())
    # 人工判定优先；历史观察不能覆盖更新的结论。
    keep = (old.get('by') == 'manual' and incoming.get('by') != 'manual') or (
        old.get('by') == incoming.get('by') and day(old.get('checked_at')) and day(incoming.get('checked_at')) and old['checked_at'] > incoming['checked_at'])
    result = deepcopy(old if keep else incoming)
    result['evidence'] = proofs
    return result


def remember(record, site, fields, proof):
    if not site:
        return
    memory = record['memories'].setdefault(site.lower(), {'fields': [], 'labels': {}})
    for item in fields:
        if sensitive(item) or item.get('action') == 'stop' or item.get('value') in (None, ''):
            continue
        label = item.get('label', '')
        if not label:
            continue
        key = item.get('key') or semantic_key(item) or 'label'
        inferred=semantic_key({'label':label})
        if key=='name' and inferred in ('url','email'):key=inferred
        if proof['by']=='plan' and key=='url' and not str(item['value']).startswith(('https://','http://')):
            continue
        old = next((x for x in memory['fields'] if x['label'] == label), None)
        saved = merge_claim(old, {**claim(item['value'], proof), 'label':label, 'key':key})
        memory['fields'] = [x for x in memory['fields'] if x['label'] != label] + [saved]
        memory['labels'][label] = saved['key']


def structure(snapshot):
    fields = []
    raw=unwrap(snapshot)
    if raw.get('fields') and all('action' in f or 'key' in f for f in raw['fields']):
        raw=deepcopy(raw)
        for f in raw['fields']:
            f.setdefault('inputType','select-one' if f.get('action')=='select' else 'text')
            f.setdefault('role','combobox' if f.get('action')=='select' else 'textbox')
    for f in snapshot_fields(raw):
        if f.get('disabled') or f.get('readonly'):
            continue
        fields.append(dict(label=f['label'], key=f.get('key') or semantic_key(f) or 'label',
                           inputType=f.get('inputType', f.get('type', 'text')),
                           role=f.get('role', 'textbox'), required=f.get('required', False),
                           maxlength=f.get('maxlength', f.get('maxLength')),
                           options=f.get('options', []), selector=f.get('selector', '')))
    return fields


def capture_recipe(record, snapshot, proof):
    snap = unwrap(snapshot)
    steps = snap.get('steps') or [snap]
    recipe_steps = []
    blockers = []
    for index, step in enumerate(steps):
        fields = structure(step)
        nxt = step.get('next', {})
        if nxt and (nxt.get('role') != 'button' or nxt.get('label') not in rules('navigation')['next_labels']):
            nxt = {}
        recipe_steps.append({'fields': fields, 'next': nxt})
        for f in fields:
            if sensitive(f):
                blockers.append(dict(kind=sensitive(f), step=index, location=f['label']))
        text = str(step.get('text', ''))
        for kind in ('captcha', 'email_verify', 'upload_verify'):
            from .core import hits
            if hits(text, rules('keywords')['signals'][kind]):
                blockers.append(dict(kind=kind, step=index, location='页面验证提示'))
    if not any(s['fields'] for s in recipe_steps):
        return
    structural = json.dumps(recipe_steps, ensure_ascii=False, sort_keys=True)
    fingerprint = hashlib.sha256(structural.encode()).hexdigest()
    old = record.get('recipe')
    if old and old['fingerprint'] != fingerprint:
        if not any(x['fingerprint'] == old['fingerprint'] for x in record['recipe_versions']):
            record['recipe_versions'].append(old)
    incomplete = bool(snap.get('nextCursor') or snap.get('truncated') or snap.get('coverage', {}).get('complete') is False)
    record['recipe'] = dict(steps=recipe_steps, blockers=blockers, fingerprint=fingerprint,
                            checked_at=proof['checked_at'], evidence=[proof], complete=not incomplete,
                            state='表单已变' if old and old['fingerprint'] != fingerprint else '已记录')


def add_history(record, row, proof):
    item = {k: v for k, v in row.items() if k in (
        'record_id', 'id', 'site', 'target_url', 'submitted_at', 'status', 'receipt',
        'first_public_at', 'raw_href', 'rel', 'last_checked_at', 'source_url', 'completed_at', 'attempted_at')}
    item['evidence'] = [proof]
    ident = item.get('record_id') or item.get('id')
    for i, old in enumerate(record['history']):
        same_kind = bool(item.get('record_id')) == bool(old.get('record_id'))
        same_site = not item.get('site') or not old.get('site') or item['site'].lower() == old['site'].lower()
        if ident and same_kind and same_site and ident == (old.get('record_id') or old.get('id')):
            proofs=old.get('evidence', []) + [x for x in item['evidence'] if x not in old.get('evidence', [])]
            old_date=old.get('last_checked_at') or old.get('completed_at','')
            new_date=item.get('last_checked_at') or item.get('completed_at','')
            if day(old_date) and day(new_date) and old_date>new_date:
                item=deepcopy(old)
            else:
                if old.get('attempted_at') and not item.get('attempted_at'):
                    item.pop('attempted_at', None)
                item={**old, **item}
            item['evidence']=proofs
            record['history'][i] = item
            break
    else:
        record['history'].append(item)
    delays = [(day(x.get('first_public_at')) - day(x.get('submitted_at'))).days
              for x in record['history'] if day(x.get('first_public_at')) and day(x.get('submitted_at'))]
    record['review_days_actual'] = [x for x in delays if x >= 0]


def observe_screen(record, row, proof):
    status = row.get('status', '待核实')
    if status in STATUSES:
        record['admission'] = merge_claim(record['admission'], claim(status, proof))
    login=str(row.get('login','UNKNOWN'))
    method=row.get('login_method')
    if method is None:
        method='Google' if 'google' in login.lower() else '邮箱注册' if any(x in login.lower() for x in ('email','邮箱','注册','password')) else '无' if login in ('无','False','false') else 'UNKNOWN'
    if method!='UNKNOWN':
        record['basic']['login_method']=merge_claim(record['basic'].get('login_method'),claim(method,proof))
    for key in ('scenario', 'dr', 'dr_date', 'fit_sites', 'login', 'review_days'):
        if row.get(key) not in (None, '', 'UNKNOWN', 'unknown'):
            record['basic'][key] = merge_claim(record['basic'].get(key), claim(row[key], proof))
    mapping = {'fee': 'cost', 'backlink': 'backlink_required', 'login': 'login',
               'captcha': 'captcha', 'license': 'license_risk', 'automation': 'automation_forbidden',
               'affiliate_terms': 'affiliate_terms'}
    reasons = row.get('reasons', [])
    if isinstance(reasons, str):
        try:
            reasons = json.loads(reasons)
        except ValueError:
            reasons = [reasons]
    for key, field in mapping.items():
        value = row.get(field, 'UNKNOWN')
        p = {**proof, 'quote': '\n'.join(str(x) for x in reasons) or proof['quote']}
        record['gates'][key] = merge_claim(record['gates'].get(key), claim(value, p))
    url = row.get('submit_url')
    if url and url != 'UNKNOWN':
        record['submit_urls'] = unique(record['submit_urls'] + [url])
        record['form_hosts'] = unique(record['form_hosts'] + [domain(url)])


def basic(record, key, default=''):
    return record.get('basic', {}).get(key, {}).get('value', default)


def apply_event(record, kind, payload, proof, site=None):
    if proof not in record['evidence']:
        record['evidence'].append(proof)
    if kind == 'screen':
        observe_screen(record, payload, proof)
    elif kind == 'capture':
        capture_recipe(record, payload, proof)
        url = unwrap(payload).get('url')
        if url:
            record['submit_urls'] = unique(record['submit_urls'] + [url])
            record['form_hosts'] = unique(record['form_hosts'] + [domain(url)])
    elif kind == 'memory':
        remember(record, site, payload, proof)
    elif kind == 'handoff':
        remember(record,payload['site'],payload.get('fields',[]),proof)
        blocker=dict(kind=payload.get('blocker','人工验证'),step=payload.get('step',0),location=payload.get('blocker_location','当前表单'),evidence=[proof])
        record.setdefault('blockers',[])
        if blocker not in record['blockers']:record['blockers'].append(blocker)
        url=payload.get('submit_url')
        if url:
            record['submit_urls']=unique(record['submit_urls']+[url])
            record['form_hosts']=unique(record['form_hosts']+[domain(url)])
    elif kind == 'history':
        add_history(record, payload, proof)
    else:
        raise ValueError('invalid_source_event')
    return record


class SourceStore:
    def __init__(self, root):
        self.root = Path(root)

    def load(self, name) -> dict:
        name = new_source(name)['domain']
        path = self.root / (name + '.json')
        return json.loads(path.read_text()) if path.exists() else new_source(name)

    def rows(self):
        return [json.loads(p.read_text()) for p in sorted(self.root.glob('*.json'))]

    @contextmanager
    def lock(self):
        from .core import protected
        if protected(self.root): raise ValueError('真实数据只读；禁止写入资源库')
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / '.library.lock').open('a') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

    def index(self):
        output_csv(self.root / 'index.csv', [dict(domain=r['domain'], status=r['admission'].get('value', '待核实'),
            scenario=basic(r, 'scenario'), dr=basic(r, 'dr'), dr_date=basic(r, 'dr_date'),
            fit_sites=basic(r, 'fit_sites'), submit_urls=r['submit_urls'],
            recipe=bool(r['recipe']), history=len(r['history'])) for r in self.rows()],
            ['domain', 'status', 'scenario', 'dr', 'dr_date', 'fit_sites', 'submit_urls', 'recipe', 'history'])

    def update(self, name, kind, payload, proof, site=None):
        with self.lock():
            r = apply_event(self.load(name), kind, payload, proof, site)
            atomic_json(self.root / (r['domain'] + '.json'), r)
            self.index()
            return r

    def import_records(self, records):
        # 锁内读取并合并，避免丢失导入期间其他进程写入的人工结论。
        with self.lock():
            for imported in records.values():
                imported = deepcopy(imported)
                current = self.load(imported['domain'])
                imported['admission']=merge_claim(current['admission'],imported['admission'])
                for group in ('basic', 'gates'):
                    for key, value in current[group].items():
                        imported[group][key] = merge_claim(value, imported[group].get(key, value))
                for site, memory in current['memories'].items():
                    for item in memory['fields']:
                        target=imported['memories'].setdefault(site,{'fields':[],'labels':{}})
                        incoming=next((x for x in target['fields'] if x['label']==item['label']),item)
                        saved=merge_claim(item,incoming)
                        target['fields']=[x for x in target['fields'] if x['label']!=item['label']]+[saved]
                        target['labels'][saved['label']]=saved['key']
                imported['history'] = current['history'] + imported['history']
                histories = imported['history']; imported['history'] = []
                for row in histories:
                    add_history(imported, row, row.get('evidence', [evidence('existing')])[-1])
                imported['submit_urls'] = unique(current['submit_urls'] + imported['submit_urls'])
                imported['form_hosts'] = unique(current['form_hosts'] + imported['form_hosts'])
                imported['evidence'] = list({json.dumps(x, sort_keys=True): x for x in current['evidence'] + imported['evidence']}.values())
                imported['blockers']=current.get('blockers',[])+[x for x in imported.get('blockers',[]) if x not in current.get('blockers',[])]
                if current['recipe'] and imported['recipe']:
                    old, incoming = current['recipe'], imported['recipe']
                    old_date = str(day(old.get('checked_at')) or '')
                    new_date = str(day(incoming.get('checked_at')) or '')
                    if old['fingerprint'] == incoming['fingerprint']:
                        recipe = deepcopy(incoming if new_date > old_date else old)
                        recipe['evidence'] = old.get('evidence', []) + [p for p in incoming.get('evidence', []) if p not in old.get('evidence', [])]
                        imported['recipe'] = recipe
                    elif new_date > old_date:
                        imported['recipe_versions'].append(old)
                        imported['recipe']['state'] = '表单已变'
                    else:
                        imported['recipe_versions'].append(incoming)
                        imported['recipe'] = old
                if current['recipe'] and not imported['recipe']:
                    imported['recipe'] = current['recipe']
                imported['recipe_versions'] = current['recipe_versions'] + [x for x in imported['recipe_versions'] if x not in current['recipe_versions']]
                atomic_json(self.root / (imported['domain'] + '.json'), imported)
            self.index()


def source_event(conf, name, kind, payload, path, site=None, by='tool', checked_at=None):
    if not conf.get('sources_dir'):
        return
    return SourceStore(conf['sources_dir']).update(name, kind, payload, evidence(path, checked_at=checked_at, by=by), site)


def source_domain(conf, url, explicit=None):
    if explicit:
        return domain(explicit)
    rows = read_csv(conf['directories'])[1]
    matches = {domain(r['domain']) for r in rows if r.get('submit_url', '').rstrip('/') == url.rstrip('/')}
    if len(matches) == 1:
        return matches.pop()
    host = domain(url)
    if host in ('tally.so', 'forms.gle', 'docs.google.com', 'form.typeform.com'):
        raise ValueError('表单宿主无法唯一关联来源，请指定 --source-domain')
    return host


def walk_objects(obj):
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            if isinstance(value, (dict, list)):
                yield from walk_objects(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from walk_objects(value)


def import_library(conf):
    records, warnings = {}, []
    counts = dict(directories=0, ledger=0, handoff=0, screens=0, snapshots=0, plans=0, raw_files=0)
    def get(name):
        name = new_source(name)['domain']
        return records.setdefault(name, new_source(name))
    directories = read_csv(conf['directories'])[1]
    urls = {r['submit_url'].rstrip('/'): domain(r['domain']) for r in directories if r.get('submit_url') not in ('', 'UNKNOWN')}
    names = {domain(r['domain']) for r in directories}
    names.update(domain(r['source_domain']) for r in read_csv(conf['ledger'])[1] if r.get('source_domain') and r['source_domain']!='UNKNOWN')
    for path in Path(conf['handoff_dir']).glob('*.json'):
        obj=json.loads(path.read_text())
        if obj.get('source_domain'): names.add(domain(obj['source_domain']))
    for i, row in enumerate(directories, 2):
        counts['directories'] += 1
        p = evidence(str(conf['directories']) + '#row=' + str(i), row.get('notes', ''), row.get('last_verified'), 'manual')
        apply_event(get(row['domain']), 'screen', row, p)
    for i, row in enumerate(read_csv(conf['ledger'])[1], 2):
        counts['ledger'] += 1
        if None in row:
            warnings.append(f'{conf["ledger"]}#row={i}: 多余列，保留可解析字段，不修原账')
        if not row.get('source_domain') or row['source_domain'] == 'UNKNOWN':
            warnings.append(f'ledger row {i}: 缺来源域'); continue
        r = get(row['source_domain'])
        proof=evidence(str(conf['ledger']) + '#row=' + str(i), checked_at=row.get('last_checked_at'),by='import')
        apply_event(r, 'history', row, proof)
        for key in ('dr','dr_date'):
            if row.get(key) not in (None,'','UNKNOWN'):
                r['basic'][key]=merge_claim(r['basic'].get(key),claim(row[key],proof))
        if row.get('channel_type') and not basic(r, 'scenario'):
            r['basic']['scenario'] = claim(row['channel_type'], evidence(conf['ledger'], by='import'))
    for path in sorted(Path(conf['runs_dir']).rglob('screen.csv')):
        for i, row in enumerate(read_csv(path)[1], 2):
            if not row.get('domain'): continue
            name = urls.get(row.get('submit_url', '').rstrip('/'), domain(row['domain']))
            counts['screens'] += 1
            apply_event(get(name), 'screen', row, evidence(str(path) + '#row=' + str(i), checked_at=row.get('last_verified'), by='tool'))
    # 日志给无 URL 的旧 capture/plan 提供明确关联；不靠目标站 URL 猜来源。
    files = list(Path(conf['runs_dir']).rglob('*.json'))
    raw_files = list(Path(conf['raw_sources_dir']).glob('*.json')) if conf.get('raw_sources_dir') else []
    associations, basename_sources = {}, {}
    for path in sorted(files):
        try:
            obj = json.loads(path.read_text())
        except (ValueError, OSError):
            warnings.append(str(path) + ': JSON不可读'); continue
        for node in walk_objects(obj):
            url = node.get('url') or node.get('submit_url')
            if isinstance(url, str) and url.startswith('http'):
                name = urls.get(url.rstrip('/'), domain(url))
                for key in ('snapshot', 'output', 'plan'):
                    if isinstance(node.get(key), str):
                        ref = Path(node[key]).expanduser()
                        candidates = [ref] if ref.is_absolute() else [path.parent / ref, Path(conf['runs_dir']).parent / ref]
                        existing = {str(p.resolve()) for p in candidates if p.is_file()}
                        if len(existing) == 1:
                            associations.setdefault(existing.pop(), set()).add(name)
                        basename_sources.setdefault(ref.name, set()).add(name)
    for path in sorted(files + raw_files, key=lambda p: (p.stat().st_mtime_ns, str(p))):
        try:
            obj = json.loads(path.read_text())
        except (ValueError, OSError):
            continue
        is_raw = path in raw_files
        if is_raw: counts['raw_files'] += 1
        nodes = list(walk_objects(obj))
        url = next((n[k] for n in nodes for k in ('requested_url', 'submit_url', 'url')
                    if isinstance(n.get(k), str) and n[k].startswith('http')), '')
        owners = associations.get(str(path.resolve())) or basename_sources.get(path.name, set())
        name = urls.get(url.rstrip('/'))
        if not name and len(owners) > 1:
            warnings.append(str(path) + ': 日志来源关联歧义，跳过配方，不猜归属')
            continue
        if not name and owners:
            name = next(iter(owners))
        if not name:
            exact = [n for n in names if n in path.name]
            if len(exact) == 1: name = exact[0]
        if not name and url:
            name = domain(url)
        # 无后缀简写仅当全库唯一匹配；不猜测 spot 等非完整来源名。
        if not name:
            tokens = re.split('[-_]', path.stem)
            matches = [n for n in names if n.split('.')[0] in tokens]
            if len(matches) == 1: name = matches[0]
        meaningful = [n for n in nodes if n.get('snapshotId') and ('items' in n or 'fields' in n)]
        if isinstance(obj, dict) and obj.get('fields') and 'status' not in obj and not meaningful:
            meaningful = [obj]
        plan = isinstance(obj, dict) and 'status' in obj and isinstance(obj.get('items'), list) and all('action' in x for x in obj['items'])
        if not name or name in ('tally.so', 'forms.gle', 'docs.google.com'):
            if meaningful or plan: warnings.append(str(path) + ': 无法唯一归属，未导入配方/计划')
            continue
        if not (is_raw or meaningful or plan): continue
        r = get(name)
        date_match = re.search(r'\d{4}-\d{2}-\d{2}', str(path))
        checked = date_match[0] if date_match else str(today())
        p = evidence(path, checked_at=checked, by='import')
        if is_raw or url:
            if p not in r['evidence']: r['evidence'].append(p)
            texts=[n.get('text','') for n in nodes if isinstance(n.get('text'),str)]
            if texts:
                from .core import screen
                observed=screen({'text':' '.join(texts)},url or 'https://'+name,{'domain':name},snapshot=True)
                apply_event(r,'screen',observed,p)
        for snap in meaningful:
            raw = unwrap(snap)
            fields = raw.get('fields') or raw.get('items', [])
            if not isinstance(fields, list) or any(not isinstance(field, dict) for field in fields):
                warnings.append(str(path) + ': 非字段对象列表，跳过配方，不影响历史导入')
                continue
            if structure(snap):
                apply_event(r, 'capture', snap, p); counts['snapshots'] += 1
        # 计划只保存备料记忆，不冒充已经填写；原错误计划优先让修正版覆盖。
        if plan:
            sites = [s for s in conf['sites'] if s in path.name.lower()]
            if len(sites) == 1:
                apply_event(r, 'memory', obj['items'], {**p, 'by': 'plan'}, sites[0]); counts['plans'] += 1
    for path in sorted(Path(conf['handoff_dir']).glob('*.json')):
        obj = json.loads(path.read_text())
        if not obj.get('source_domain') or not obj.get('site'): continue
        r = get(obj['source_domain']); counts['handoff'] += 1
        p = evidence(path, obj.get('blocker_location', ''), obj.get('created_at'), 'manual')
        # handoff 中的 fields 是备料计划；实际回读已单独写入来源记忆，不能在导入时提权。
        apply_event(r, 'handoff', obj, {**p, 'by': 'plan'})
        apply_event(r, 'history', obj, p)
    return records, dict(inputs=counts, **statistics(records.values()), warnings=warnings)


def statistics(records):
    records = list(records)
    return dict(total=len(records), statuses={s: sum(r['admission'].get('value', '待核实') == s for r in records) for s in STATUSES},
                with_recipe=sum(bool(r['recipe']) for r in records), with_history=sum(bool(r['history']) for r in records))


def submitted(record, site, ledger, *, include_in_progress=True):
    excluded = EXCLUDED if include_in_progress else EXCLUDED - {'续填中'}
    return any(domain(row.get('source_domain', record['domain'])) == record['domain'] and
               row.get('site', '').lower() == site.lower() and
               (bool(row.get('attempted_at')) or row.get('status', '').lower() in excluded)
               for row in list(ledger) + record['history'])


def campaign(records, ledger, site, kit):
    result = dict(ready=[], handoff=[], capture=[], excluded={})
    seen=set()
    for r in sorted(records, key=lambda x: x['domain']):
        if r['domain'] in seen:continue
        seen.add(r['domain'])
        name = r['domain']
        reason = ''
        if r['admission'].get('value') not in ('可投', '待饼哥'): reason = '准入未通过'
        elif site.lower() not in re.split(r'[|,\s]+', basic(r, 'fit_sites').lower()): reason = '不对口'
        elif not fresh_dr(dict(dr=basic(r, 'dr'), dr_date=basic(r, 'dr_date'))): reason = 'DR缺失或过期'
        elif float(basic(r, 'dr')) < rules('policy')['dr_min']: reason = 'DR不足'
        elif submitted(r, site, ledger): reason = '已有提交或未知结果'
        elif rules('policy')['scenarios'].get(basic(r, 'scenario', 'directory')) != 'preapproved': reason = '需外联草稿或批准'
        # 待饼哥只在其余硬门槛有明确证据时可直接备续填。
        elif r['admission'].get('value') == '待饼哥' and not (
            r['gates'].get('fee', {}).get('value') in ('free', '免费', '无') and
            r['gates'].get('backlink', {}).get('value') in (False, '无', 'false', 'False') and
            r['gates'].get('license', {}).get('value') in (False, 'false', 'False', '无') and
            r['gates'].get('automation', {}).get('value') in (False, 'false', 'False', '无')):
            reason = '人工卡点之外的准入证据未齐'
        if reason:
            result['excluded'][name] = reason; continue
        recipe = r.get('recipe')
        base = dict(source_domain=name, site=site, submit_url=r['submit_urls'][0] if r['submit_urls'] else '',
                    dr=basic(r, 'dr'), dr_date=basic(r, 'dr_date'))
        if not recipe or not recipe.get('complete') or recipe.get('state') == '表单已变' or not day(recipe['checked_at']) or not 0 <= (today()-day(recipe['checked_at'])).days < rules('policy')['handoff_days']:
            result['capture'].append({**base, 'reason': '需先 capture：配方缺失、不完整、过期或已变'}); continue
        memory = r['memories'].get(site, {'fields': [], 'labels': {}})
        plans = []
        for step in recipe['steps']:
            snap = deepcopy(step)
            for f in snap['fields']:
                f['key'] = memory['labels'].get(f['label'], f.get('key'))
            plans.append(fillplan(snap, kit, memory['fields']))
        blockers=recipe['blockers']+r.get('blockers',[])
        if r['admission'].get('value')=='待饼哥' and not blockers:
            blockers=[dict(kind='人工验证',step=0,location='准入档案中的人工停点')]
        item = {**base, 'plans': plans, 'steps': recipe['steps'], 'blockers': blockers}
        if blockers or any(p['status'] != 'ready' for p in plans):
            result['handoff'].append(item)
        else:
            result['ready'].append(item)
    return result
