"""外链库的规范字段、提交口径、文件交换和批量维护。"""
import csv
import io
import json
import math
import re
from collections import Counter
from copy import deepcopy
from pathlib import Path

from . import core as c, sources as s

TYPES = {'directory': '目录', 'launch': 'Launch', 'resource': '资源页', 'roundup': 'Roundup',
         'community': '社区', 'comment': '评论', 'producthunt': 'Product Hunt', 'other': '其他'}
FEES = {'free': '免费', 'freemium': '免费+付费加速', 'paid': '付费', 'unknown': '未知'}
SUCCESS = {'submitted', 'public', 'live'}
PROCESSING = {'unknown', 'pending', '结果未知', '待核实', '续填中', '待处理', '待授权', '待人工', '需重新备料'}
EXPORT_FIELDS = ['url', 'domain', 'type', 'fee', 'dr', 'dr_date', 'status', 'submit_count', 'submitted_products', 'note']


def normalize_type(value):
    value = str(value or '').strip().lower()
    aliases = {label.lower(): key for key, label in TYPES.items()}
    aliases.update(outreach='other', **{'product hunt': 'producthunt'})
    return value if value in TYPES else aliases.get(value, '')


def normalize_fee(value):
    text = str(value or '').strip().lower()
    if text in FEES:
        return text
    free = bool(re.search(r'免费|\bfree\b|\$\s*0(?:\.0+)?(?:\D|$)|(?<![\d.])0(?=\D|$)', text))
    paid = bool(re.search(r'付费|premium|featured|置顶|optional|\bpaid\b|收费|加速', text))
    if free:
        return 'freemium' if paid else 'free'
    return 'paid' if paid or re.search(r'[$€£¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:usd|eur|元|美元)', text) else 'unknown'


def submissions(record, rows, site=''):
    history = record.get('history', []) + [r for r in rows if c.domain(r.get('source_domain', '')) == record['domain']]
    successes = {}
    pending = set()
    for row in history:
        name = str(row.get('site', '')).lower()
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name):
            continue
        status = row.get('status')
        date = next((str(c.day(row.get(k))) for k in ('completed_at', 'submitted_at', 'first_public_at', 'created_at') if c.day(row.get(k))), '')
        if status in SUCCESS:
            successes[name] = max(successes.get(name, ''), date)
        elif status in PROCESSING or row.get('attempted_at') and status not in ('failed', 'abandoned', 'cancelled'):
            pending.add(name)
    state = 'submitted' if site in successes else 'processing' if site and site in pending else 'unsubmitted'
    if not site:
        state = 'submitted' if successes else 'unsubmitted'
    return dict(submission_status=state, submit_count=len(successes),
                submitted_products=[dict(site=k, date=v) for k, v in sorted(successes.items())],
                last_submitted_at=max(successes.values(), default=''))


def decorate(record, row, rows, site):
    row.update(submissions(record, rows, site))
    row['scenario'] = normalize_type(row['scenario'])
    row['fee'] = normalize_fee(row['fee'])
    row['dr_fresh'] = c.fresh_dr(row)
    return row


def paginate(items, query):
    fee = query.get('fee') or 'all'
    state = query.get('submission_status') or 'all'
    if fee not in (*FEES, 'all') or state not in ('all', 'submitted', 'processing', 'unsubmitted'):
        raise ValueError('invalid_library_filter')
    try:
        page, size = int(query.get('page', 1)), int(query.get('page_size', 50))
        minimum = float(query.get('dr_min') or 0)
        maximum = float(query.get('dr_max') or 100)
        if page < 1 or size not in (20, 50, 100) or not 0 <= minimum <= maximum <= 100:
            raise ValueError()
    except (TypeError, ValueError):
        raise ValueError('invalid_library_pagination') from None
    def number(row):
        try:
            value = float(row['dr'])
            return value if math.isfinite(value) else -1
        except (TypeError, ValueError):
            return -1
    items = [r for r in items if (fee == 'all' or r['fee'] == fee) and
             (state == 'all' or r['submission_status'] == state) and
             (not query.get('dr_min') and not query.get('dr_max') or minimum <= number(r) <= maximum)]
    sort = query.get('sort') or 'dr'
    if sort not in ('dr', 'submit_count', 'last_submitted_at') or query.get('order', 'desc') not in ('asc', 'desc'):
        raise ValueError('invalid_library_sort')
    items.sort(key=lambda r: (number(r) if sort == 'dr' else r[sort], r['domain']), reverse=query.get('order', 'desc') == 'desc')
    total = len(items)
    return dict(items=items[(page - 1) * size:page * size], total=total, page=page, page_size=size), items


def selected(conf, data):
    from .library import listing, validate
    if data.get('all_filtered'):
        query = dict(data.get('filters') or {}, page=1, page_size=100)
        first = listing(conf, query)
        rows = first['items']
        for page in range(2, (first['total'] + 99) // 100 + 1):
            rows += listing(conf, dict(query, page=page))['items']
        excluded = data.get('excluded_domains') or []
        if not isinstance(excluded, list) or any(not isinstance(name, str) for name in excluded):
            raise ValueError('invalid_excluded_domains')
        return [r['domain'] for r in rows if r['domain'] not in set(excluded)]
    names = data.get('domains')
    if not isinstance(names, list) or not names or len(names) > 20000:
        raise ValueError('select_platforms')
    return s.unique([validate(conf, {'domain': name})['domain'] for name in names])


def spreadsheet_escape(value):
    return isinstance(value, str) and (value.startswith(("'", '\t', '\r', '\n')) or value.lstrip().startswith(('=', '+', '-', '@')))


def csv_text(rows, fields=EXPORT_FIELDS):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fields, extrasaction='ignore')
    writer.writeheader()
    for row in rows:
        writer.writerow({key: "'" + value if spreadsheet_escape(value) else value
                         for key in fields for value in [row.get(key, '')]})
    return '\ufeff' + stream.getvalue()


def export_rows(conf, data):
    from .library import item, history_rows
    site = data.get('site') or (data.get('filters') or {}).get('site', '')
    rows = history_rows(conf)
    store = s.SourceStore(conf['sources_dir'])
    result = []
    for name in selected(conf, data):
        record = store.load(name)
        row = decorate(record, item(record, site, rows), rows, site)
        result.append(dict(url=row['submit_url'], domain=name, type=row['scenario'], fee=row['fee'],
                           dr=row['dr'], dr_date=row['dr_date'], status=row['submission_status'],
                           submit_count=row['submit_count'], submitted_products='|'.join(p['site'] for p in row['submitted_products']), note=row['note']))
    return result


def import_file(conf, data, confirm=False):
    from .library import safe_url
    text = data.get('text')
    if not isinstance(text, str) or len(text) > 5_000_000 or data.get('format') not in ('csv', 'txt'):
        raise ValueError('invalid_import_file')
    raw = csv.DictReader(io.StringIO(text.lstrip('\ufeff'))) if data['format'] == 'csv' else ({'url': line.strip()} for line in text.splitlines())
    if data['format'] == 'csv' and 'url' not in (raw.fieldnames or []):
        raise ValueError('CSV 必须包含 url 列')
    store = s.SourceStore(conf['sources_dir'])
    seen, changes, skipped = set(), [], []
    for index, row in enumerate(raw, 2 if data['format'] == 'csv' else 1):
        reason = '链接或字段无效（内网、敏感参数或未知类型）'
        try:
            url = safe_url(row.get('url', ''))
            name = c.domain(url)
            if name in seen:
                reason = '同文件域名重复'
                raise ValueError(reason)
            seen.add(name)
            kind, fee = normalize_type(row.get('type')), normalize_fee(row.get('fee'))
            if row.get('type') and not kind:
                raise ValueError('未知外链类型')
            note = row.get('note') or ''
            if data['format'] == 'csv' and note.startswith("'") and spreadsheet_escape(note[1:]):
                note = note[1:]
            if not isinstance(note, str) or len(note) > 10000:
                raise ValueError('备注过长')
            changes.append(dict(domain=name, url=url, type=kind, fee=fee, note=note, line=index))
        except (ValueError, TypeError):
            # 无效 URL 可能含私密参数；报告只返回行号和原因。
            skipped.append(dict(line=index, reason=reason))
    def merge(change):
        record = store.load(change['domain'])
        before = deepcopy(record)
        proof = s.evidence('library:import', by='manual')
        for group, key, value in [('basic', 'scenario', change['type']), ('gates', 'fee', change['fee']), ('basic', 'library_note', change['note'])]:
            if value and value != 'unknown' and record[group].get(key, {}).get('value') in (None, '', 'UNKNOWN', 'unknown'):
                record[group][key] = s.claim(value, proof)
        if change['url'] not in record['submit_urls']:
            record['submit_urls'].append(change['url'])
            record['form_hosts'] = s.unique(record['form_hosts'] + [c.domain(change['url'])])
        return record, before != record
    def apply():
        result = dict(added=0, updated=0, skipped=skipped.copy(), domains=[])
        for change in changes:
            exists = (store.root / (change['domain'] + '.json')).exists()
            record, changed = merge(change)
            if not changed:
                result['skipped'].append(dict(line=change['line'], reason='已存在，无空字段可补全'))
                continue
            result['added' if not exists else 'updated'] += 1
            result['domains'].append(change['domain'])
            if confirm:
                c.atomic_json(store.root / (record['domain'] + '.json'), record)
        if confirm:
            store.index()
        return result
    if not confirm:
        return apply()
    with store.lock():
        result = apply()
    if result['domains']:
        try:
            result['dr'] = refresh_dr(conf, result['domains'])
        except ValueError as error:
            result['dr_error'] = str(error)
    return result


def refresh_dr(conf, names):
    store = s.SourceStore(conf['sources_dir'])
    if c.protected(store.root):
        raise ValueError('真实数据只读；禁止刷新 DR')
    cache = Path(conf.get('dr_cache') or Path(conf['ledger']).parent / 'dr-cache.csv')
    if c.protected(cache):
        raise ValueError('真实缓存只读；禁止刷新 DR')
    cached = c.read_csv(cache)[1] if cache.exists() else []
    cached = {c.domain(r.get('domain', '')): dict(dr=r.get('dr'), dr_date=r.get('checked_date') or r.get('dr_date')) for r in cached}
    rows = []
    for name in names:
        record = store.load(name)
        row = dict(domain=name, dr=s.basic(record, 'dr'), dr_date=s.basic(record, 'dr_date'))
        if c.fresh_dr(row):
            continue
        if c.fresh_dr(cached.get(name, {})):
            row.update(cached[name])
        rows.append(row)
    # 额度和鉴权异常向上传递；不写入部分 DR，不使用旧值替代。
    c.enrich_dr(rows, conf['ahrefs_script'], conf_dr_cache=str(cache))
    with store.lock():
        for row in rows:
            if not c.fresh_dr(row):
                continue
            record = store.load(row['domain'])
            proof = s.evidence('Ahrefs:DR', checked_at=row['dr_date'])
            for key in ('dr', 'dr_date'):
                record['basic'][key] = s.claim(row[key], proof)
            c.atomic_json(store.root / (record['domain'] + '.json'), record)
        store.index()
    return dict(queried=len(rows), found=sum(c.fresh_dr(r) for r in rows))


def bulk(conf, data):
    from .library import history_rows
    names, action = selected(conf, data), data.get('action')
    store = s.SourceStore(conf['sources_dir'])
    if action == 'refresh_dr':
        return refresh_dr(conf, names)
    if action not in ('delete', 'scenario', 'fee', 'mark', 'unmark'):
        raise ValueError('invalid_bulk_action')
    value, site = data.get('value'), data.get('site')
    if action == 'delete' and data.get('confirmation') != 'DELETE ' + str(len(names)):
        raise ValueError('delete_confirmation_required')
    if action == 'scenario' and value not in TYPES or action == 'fee' and value not in FEES:
        raise ValueError('invalid_bulk_value')
    if action in ('mark', 'unmark') and site not in conf['sites']:
        raise ValueError('select_product')
    proof = s.evidence('library:manual', by='manual')
    with store.lock():
        ledger_path = Path(conf['ledger'])
        fields, ledger = c.read_csv(ledger_path) if ledger_path.exists() else ([], [])
        for name in names:
            path = store.root / (name + '.json')
            if action == 'delete':
                path.unlink(missing_ok=True)
                continue
            record = store.load(name)
            if action in ('scenario', 'fee'):
                record['basic' if action == 'scenario' else 'gates'][action] = s.claim(value, proof)
            elif action == 'mark':
                ident = 'manual:' + site + ':' + name
                if not any(r.get('record_id') == ident for r in ledger):
                    ledger.append(dict(record_id=ident, source_domain=name, site=site, status='submitted', submitted_at=str(c.today())))
                record['history'] = [r for r in record['history'] if not (r.get('manual_mark') and r.get('site') == site)]
                record['history'].append(dict(site=site, status='submitted', submitted_at=str(c.today()), manual_mark=True))
            else:
                ledger = [r for r in ledger if r.get('record_id') != 'manual:' + site + ':' + name]
                record['history'] = [r for r in record['history'] if not (r.get('manual_mark') and r.get('site') == site)]
            c.atomic_json(path, record)
        from .batch import BatchStore
        batches = BatchStore(conf)
        touched = []
        if action in ('mark', 'unmark', 'delete'):
            for batch in batches.rows():
                changed = False
                for job in batch['jobs']:
                    if job['domain'] not in names or action != 'delete' and batch['site'] != site:
                        continue
                    target = None
                    if action == 'mark' and job['state'] in ('queued','running','manual','unknown'):
                        target = 'success'
                        job['manual_mark'] = True
                    elif action == 'unmark' and job.get('manual_mark'):
                        target = 'abandoned'
                        job.pop('manual_mark', None)
                    elif action == 'delete' and job['state'] in ('queued','running') and not job.get('attempted_at'):
                        target = 'cancelled'
                    if target:
                        from .handoff import stamp
                        job.update(state=target, reason='人工维护平台', finished_at=stamp(), committed=True)
                        batches.update_handoff(job, batch)
                        changed = True
                if changed:
                    batches.save(batch)
                    touched.append(batch)
        if action in ('mark', 'unmark'):
            c.output_csv(ledger_path, ledger, s.unique(fields + ['record_id','source_domain','site','status','submitted_at']))
        store.index()
        for batch in touched:
            batches.finish(batch)
    return dict(changed=len(names), action=action)


def migration(conf, apply=False):
    from .library import history_rows
    store = s.SourceStore(conf['sources_dir'])
    rows = history_rows(conf)
    report = dict(total=0, before_type=Counter(), after_type=Counter(), before_fee=Counter(), after_fee=Counter(),
                  unclassified_type=Counter(), unclassified_fee=Counter(), submitted_platforms=0, submitted_products=0)
    for record in store.rows():
        old_type, old_fee = s.basic(record, 'scenario', ''), record['gates'].get('fee', {}).get('value', '')
        kind, fee = normalize_type(old_type), normalize_fee(old_fee)
        report['total'] += 1
        for key, value in [('before_type', old_type), ('after_type', kind), ('before_fee', old_fee), ('after_fee', fee)]:
            report[key][str(value)] += 1
        if not kind and old_type not in ('', 'UNKNOWN'):
            report['unclassified_type'][str(old_type)] += 1
        if fee == 'unknown' and old_fee not in ('', 'UNKNOWN', 'unknown'):
            report['unclassified_fee'][str(old_fee)] += 1
        stats = submissions(record, rows)
        report['submitted_platforms'] += stats['submit_count'] > 0
        report['submitted_products'] += stats['submit_count']
        if apply:
            proof = s.evidence('library:v2-migration')
            if old_type and old_type != kind:
                record['basic'].setdefault('library_original_scenario', s.claim(old_type, proof))
            record['basic']['scenario'] = s.claim(kind, proof)
            record['gates']['fee'] = s.claim(fee, proof)
            note = s.basic(record, 'library_note', '')
            original = '原费用：' + str(old_fee)
            if old_fee not in FEES and original not in note:
                record['basic']['library_note'] = s.claim((note + '\n' + original).strip(), proof)
            record['history'] += [dict(r) for r in rows if c.domain(r.get('source_domain', '')) == record['domain'] and r.get('status') in SUCCESS and r not in record['history']]
            record['submission_summary'] = stats
            c.atomic_json(store.root / (record['domain'] + '.json'), record)
    return report
