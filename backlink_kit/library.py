"""本机外链库与持久备料；复用来源档案，不执行网站请求或提交。"""
import ipaddress
import json
import math
import re
from copy import deepcopy
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

from . import handoff, kits
from .core import atomic_json, day, domain, read_csv, rules
from .sources import SourceStore, basic, campaign, claim, evidence, merge_claim, submitted, unique


def public_host(host):
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return bool(isinstance(host, str) and len(host) <= 253 and '.' in host and
                    not host.endswith(('.localhost', '.local', '.internal')) and
                    not host.rsplit('.', 1)[-1].isdigit() and
                    all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                        for label in host.split('.')))


def safe_url(value):
    if not isinstance(value, str) or re.search(r'[\s\\\x00-\x1f\x7f]', unquote(value)):
        raise ValueError('invalid_submit_url')
    parsed = urlsplit(value)
    if (parsed.scheme not in ('https', 'http') or not public_host(parsed.hostname) or
            parsed.username is not None or parsed.password is not None):
        raise ValueError('invalid_submit_url')
    for component in (parsed.query, parsed.fragment):
        for _ in range(4):
            decoded = unquote(component)
            if decoded == component:
                break
            component = decoded
        else:
            raise ValueError('private_submit_url')
        if any(re.search(r'token|password|secret|key|auth|email|session|(?:^|_)code$', key, re.I)
               for key, _ in parse_qsl(component.replace('?', '&'), keep_blank_values=True)):
            raise ValueError('private_submit_url')
    port = parsed.port  # 非法端口在任何写入前拒绝。
    host = parsed.hostname
    host = '[' + host + ']' if ':' in host else host
    netloc = host + (':' + str(port) if port and port != (443 if parsed.scheme == 'https' else 80) else '')
    return urlunsplit((parsed.scheme, netloc, parsed.path or '/', parsed.query, ''))


def validate(conf, data):
    allowed = {'domain', 'submit_url', 'scenario', 'admission', 'note', 'dr', 'dr_date',
               'fit_sites', 'fee', 'backlink'}
    if not isinstance(data, dict) or set(data) - allowed:
        raise ValueError('invalid_library_payload')
    data = dict(data)
    name = data.get('domain')
    if not isinstance(name, str) or not public_host(name.lower()) or ':' in name or '/' in name:
        raise ValueError('invalid_source_domain')
    data['domain'] = domain(name)
    for key in allowed - {'domain'}:
        value = data.get(key)
        if value is None or value == '' and key != 'note' or value == 'UNKNOWN':
            data.pop(key, None)
            continue
        valid = True
        if key == 'submit_url':
            data[key] = safe_url(value)
        elif key == 'admission':
            valid = value in ('待核实', '可投', '不做')
        elif key == 'scenario':
            valid = isinstance(value, str) and value in rules('policy')['scenarios']
        elif key == 'fee':
            valid = value in ('free', 'paid')
        elif key == 'backlink':
            valid = isinstance(value, bool)
        elif key == 'fit_sites':
            valid = isinstance(value, list) and all(isinstance(s, str) and s in conf['sites'] for s in value)
        elif key == 'dr':
            try:
                valid = not isinstance(value, bool) and math.isfinite(float(value)) and 0 <= float(value) <= 100
            except (ValueError, TypeError):
                valid = False
        elif key == 'dr_date':
            valid = isinstance(value, str) and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', value)) and day(value) is not None
        elif key == 'note':
            valid = isinstance(value, str) and len(value) <= 10000
        if not valid:
            raise ValueError('invalid_library_' + key)
    return data


def qualification(record, site, ledger, kit):
    gates = record['gates']
    if site and submitted(record, site, ledger):
        return 'already_submitted', ['已有提交或未知结果；先核实，禁止重复提交']
    if site and any(row.get('site', '').lower() == site and
                    domain(row.get('source_domain', record['domain'])) == record['domain'] and
                    row.get('status') in ('待处理', '待授权', '待人工', '需重新备料')
                    for row in list(ledger) + record['history']):
        return 'needs_review', ['已有续填任务；请从任务列表核对，勿重复备料']
    if record['admission'].get('value') == '不做':
        return 'blocked', ['平台准入为不做']
    if gates.get('fee', {}).get('value') in ('paid', '付费'):
        return 'blocked', ['平台要求付费']
    if gates.get('backlink', {}).get('value') in (True, 'true', 'True', '是'):
        return 'blocked', ['平台要求反链']
    if any(gates.get(key, {}).get('value') in (True, 'true', 'True', '是') for key in ('license', 'automation')):
        return 'blocked', ['许可或自动化限制未通过']
    if not site:
        return 'unknown', ['请选择产品后核对复用资格']
    if (gates.get('fee', {}).get('value') not in ('free', '免费', '无') or
            gates.get('backlink', {}).get('value') not in (False, 'false', 'False', '无')):
        return 'needs_review', ['费用或回链要求尚未明确核实']
    if not usable_urls(record):
        return 'needs_review', ['缺少安全有效的提交地址']
    if record.get('recipe') and not record['recipe'].get('steps'):
        return 'needs_review', ['配方缺少表单步骤；请重新录制']
    result = campaign([record], ledger, site, kit)
    if result['ready']:
        return 'ready', []
    if result['excluded']:
        return 'needs_review', [result['excluded'][record['domain']]]
    if result['capture']:
        return 'needs_review', [result['capture'][0]['reason']]
    return 'needs_review', ['需人工处理表单卡点或补齐当前产品资料']


def history_summary(rows):
    result = []
    statuses = set(rules('policy')['queue_exclude'] + rules('policy')['handoff_statuses']) | {
        'candidate', 'drafted', 'approved', 'blocked', 'rejected', 'failed', 'skipped'}
    for row in rows:
        site = str(row.get('site', '')).lower()
        if not re.fullmatch(r'[a-z][a-z0-9-]*', site):
            continue
        status = row.get('status', '')
        summary = dict(site=site, status=status if status in statuses else 'UNKNOWN', date='')
        for key in ('first_public_at', 'last_checked_at', 'completed_at', 'submitted_at', 'attempted_at', 'created_at'):
            if day(row.get(key)):
                summary['date'] = str(day(row[key]))
                break
        if status in ('public', 'alive', 'live'):
            for key in ('source_url', 'raw_href'):
                try:
                    url = safe_url(row.get(key))
                except (ValueError, TypeError):
                    continue
                summary[key] = url
        if summary not in result:
            result.append(summary)
    return result


def usable_urls(record):
    result = []
    for url in record['submit_urls']:
        try:
            result.append(safe_url(url))
        except ValueError:
            continue
    return unique(result)


def item(record, site='', ledger=(), kit=None):
    state, reasons = qualification(record, site, ledger, kit)
    history = history_summary(record['history'] + [r for r in ledger
        if domain(r.get('source_domain', '')) == record['domain']])
    dates = [p.get('checked_at') for p in record['evidence']]
    dates += [record.get('recipe', {}).get('checked_at')] if record.get('recipe') else []
    dates += [r.get('last_checked_at') for r in record['history']]
    checked = max((str(day(d)) for d in dates if day(d)), default='')
    return dict(domain=record['domain'], submit_url=next(iter(usable_urls(record)), ''),
                scenario=basic(record, 'scenario', 'UNKNOWN'),
                fit_sites=[name for name in re.split(r'[|,\s]+', str(basic(record, 'fit_sites', ''))) if name and name != 'UNKNOWN'],
                note=basic(record, 'library_note', ''),
                admission=record['admission'].get('value', '待核实'), reuse_state=state,
                reasons=reasons, dr=basic(record, 'dr', 'UNKNOWN'),
                dr_date=basic(record, 'dr_date', 'UNKNOWN'),
                fee=record['gates'].get('fee', {}).get('value', 'UNKNOWN'),
                login=basic(record, 'login', 'UNKNOWN'),
                backlink=record['gates'].get('backlink', {}).get('value', 'UNKNOWN'),
                has_recipe=bool(record.get('recipe')), previous_sites=sorted({r['site'] for r in history}), history=history,
                last_checked_at=checked)


def history_rows(conf):
    rows = read_csv(conf['ledger'])[1] if Path(conf['ledger']).exists() else []
    rows += [json.loads(path.read_text()) for path in sorted(Path(conf['handoff_dir']).glob('*.json'))]
    return rows


def listing(conf, query):
    site = query.get('site') or ''
    status = query.get('status') or 'all'
    scenario = query.get('scenario') or 'all'
    if status not in ('all', 'confirmed', 'ready', 'needs_review', 'already_submitted', 'blocked', 'unknown'):
        raise ValueError('invalid_library_status')
    if scenario != 'all' and scenario not in rules('policy')['scenarios']:
        raise ValueError('invalid_library_scenario')
    if site and site not in conf['sites']:
        raise ValueError('unknown_site')
    kit = kits.load(conf, site)[0] if site else None
    ledger = history_rows(conf)
    q = (query.get('q') or '').strip().lower()
    records = [r for r in SourceStore(conf['sources_dir']).rows()
               if (not q or q in r['domain'].lower() or any(q in url.lower() for url in r['submit_urls']))
               and (scenario == 'all' or basic(r, 'scenario') == scenario)]
    items = [item(r, site, ledger, kit) for r in records]
    items = [r for r in items if status == 'all' or
             (r['admission'] == '可投' if status == 'confirmed' else r['reuse_state'] == status)]
    # 计数与返回条目使用完全相同的四项筛选，不混用全库总数。
    counts = dict(total=len(items), confirmed=sum(r['admission'] == '可投' for r in items))
    counts.update({state: sum(r['reuse_state'] == state for r in items)
                   for state in ('ready', 'needs_review', 'already_submitted', 'blocked')})
    return dict(items=items, counts=counts, site=site)


def prepare(conf, data):
    if (not isinstance(data, dict) or set(data) != {'domain', 'site'} or
            not isinstance(data.get('site'), str) or data['site'] not in conf['sites']):
        raise ValueError('invalid_library_prepare')
    name = validate(conf, {'domain': data['domain']})['domain']
    site = data['site']
    sources = SourceStore(conf['sources_dir'])
    tasks = handoff.Store(conf['handoff_dir'], conf)
    # 与来源更新共用锁；相同平台并发备料只能创建一个持久任务。
    with sources.lock():
        record = sources.load(name)
        url = next(iter(usable_urls(record)), '')
        existing = tasks.rows()
        matching = [r for r in existing if r['source_domain'] == name and r['site'] == site and
                    r['submit_url'] == url and r['status'] in ('待处理', '待人工', '待授权')]
        others = [r for r in existing if r not in matching]
        # 活动任务的导入历史仅用于排重；未知/已提交历史始终保留并优先阻断。
        record = deepcopy(record)
        ids = {r['id'] for r in matching}
        ledger = [r for r in history_rows(conf) if not (
            r.get('id') in ids and r.get('status') in ('待处理', '待人工', '待授权'))]
        record['history'] = [r for r in record['history'] if not (
            r.get('id') in ids and r.get('status') in ('待处理', '待人工', '待授权'))]
        kit = kits.load(conf, site)[0]
        state, reasons = qualification(record, site, ledger + others, kit)
        if state != 'ready':
            raise ValueError('library_not_ready: ' + '；'.join(reasons))
        if matching:
            with tasks.lock(matching[0]['id']):
                saved = tasks.load(matching[0]['id'])
                if saved['status'] not in ('待处理', '待人工', '待授权'):
                    raise ValueError('任务状态已变；请先核实，禁止重放')
        else:
            current = campaign([record], ledger + others, site, kit)['ready'][0]
            steps = [{'fields': plan['items'], 'next': step.get('next', {})}
                     for plan, step in zip(current['plans'], current['steps'])]
            saved = handoff.save_progress(tasks.root, name, site, url, current['plans'][0],
                                          steps=steps, blocker='', location='')
            saved = tasks.load(saved['id'])
        return {key: saved[key] for key in ('id', 'site', 'submit_url')}


def save(conf, data):
    data = validate(conf, data)
    store = SourceStore(conf['sources_dir'])
    proof = evidence('extension:library', data.get('note', ''), by='manual')
    with store.lock():
        record = store.load(data['domain'])
        if proof not in record['evidence']:
            record['evidence'].append(proof)
        admission = data.get('admission') or record['admission'].get('value', '待核实')
        if data.get('admission') or not record['admission']:
            record['admission'] = merge_claim(record['admission'], claim(admission, proof))
        for key in ('scenario', 'dr', 'dr_date', 'fit_sites'):
            if key not in data:
                continue
            value = '|'.join(unique(data[key])) if key == 'fit_sites' else data[key]
            record['basic'][key] = merge_claim(record['basic'].get(key), claim(value, proof))
        if 'note' in data:
            record['basic']['library_note'] = merge_claim(record['basic'].get('library_note'), claim(data['note'], proof))
        for key in ('fee', 'backlink'):
            value = data.get(key)
            if value not in (None, '', 'UNKNOWN'):
                record['gates'][key] = merge_claim(record['gates'].get(key), claim(value, proof))
        url = data.get('submit_url')
        if url:
            record['submit_urls'] = unique([url] + record['submit_urls'])
            record['form_hosts'] = unique(record['form_hosts'] + [domain(url)])
        atomic_json(store.root / (record['domain'] + '.json'), record)
        store.index()
    return item(record)
