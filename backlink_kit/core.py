"""纯数据逻辑和受控文件/HTTP 边界；不执行浏览器或提交。"""
from __future__ import annotations
import csv
import hashlib
import html
from html.parser import HTMLParser
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile
from datetime import date, datetime, timedelta
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from http.client import HTTPException

ROOT = Path(__file__).resolve().parents[1]
REAL_DATA = Path(os.environ.get('BK_REAL_DATA_DIR', Path.home() / 'Desktop/works/reports/backlinks')).expanduser()


def rules(name):
    return json.loads((ROOT / 'rules' / (name + '.json')).read_text())


def load_config(path=None):
    path = Path(path or ROOT / 'config.json').resolve()
    conf = json.loads(path.read_text())
    conf.setdefault('sources_dir', str(Path(conf['directories']).parent / 'sources'))
    reports = Path(conf['directories']).parent
    # 快照、日志、设置、上传暂存都由本机服务持有；默认放在 reports/backlinks 下，可用 config 覆盖。
    conf.setdefault('snapshots_dir', str(reports / 'snapshots'))
    conf.setdefault('logs_dir', str(reports / 'logs' / 'fast-backlink'))
    conf.setdefault('settings_dir', str(reports / 'settings'))
    conf.setdefault('stage_dir', str(Path(tempfile.gettempdir()) / 'fast-backlink-stage'))
    conf.setdefault('learned_file', str(ROOT / 'rules' / 'learned.json'))
    for key in ('sources_dir', 'raw_sources_dir', 'directories', 'ledger', 'sites_file', 'kits_source', 'kits_dir',
                'runs_dir', 'handoff_dir', 'ahrefs_script', 'browser_script', 'outreach_template',
                'snapshots_dir', 'logs_dir', 'settings_dir', 'stage_dir', 'learned_file'):
        if key not in conf:
            continue
        p = Path(str(conf[key])).expanduser()
        conf[key] = str(p if p.is_absolute() else path.parent / p)
    return conf


def today():
    return date.today()


def day(value):
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def domain(url):
    p = urlsplit(url if '://' in url else 'https://' + url)
    return (p.hostname or '').lower().removeprefix('www.').rstrip('.')


def read_csv(path):
    with Path(path).open(encoding='utf-8-sig', newline='') as f:
        r = csv.DictReader(f)
        return list(r.fieldnames or []), list(r)


def atomic_json(path, obj):
    path = Path(path)
    if protected(path):
        raise ValueError('真实数据只读；禁止写入')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.bk-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, indent=2, allow_nan=False)
            f.write('\n')
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def protected(path):
    # 测试时设 BK_PROTECT_REAL=1，防止误写真实台账；日常 --apply 先备份再写。
    if os.environ.get('BK_PROTECT_REAL') != '1':
        return False
    p = Path(path).resolve()
    return p.is_relative_to(REAL_DATA)


def write_csv(path, fields, rows, apply=False):
    path = Path(path)
    if protected(path):
        raise ValueError('真实数据只读；--apply 仅允许显式配置的测试副本')
    path.parent.mkdir(parents=True, exist_ok=True)
    if apply and path.exists():
        shutil.copy2(path, path.with_name(path.name + '.' + datetime.now().strftime('%Y%m%d%H%M%S%f') + '.bak'))
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.bk-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
            w.writeheader()
            w.writerows(rows)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def output_csv(path, rows, fields=None):
    fields = fields or list(dict.fromkeys(k for row in rows for k in row)) or ['status']
    write_csv(path, fields, [{k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v for k, v in r.items()} for r in rows])


def append_note(row, note):
    row['notes'] = (row.get('notes', '') + '；' + note).strip('；')


def fetch(url, timeout=10):
    if urlsplit(url).scheme not in ('http', 'https'):
        return {'status': 'fetch_failed', 'reason': 'invalid_url', 'url': url, 'html': ''}
    for attempt in range(2):
        try:
            with urlopen(Request(url, headers={'Accept': 'text/html'}), timeout=timeout) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    return {'status': 'browser_required', 'reason': 'page_too_large', 'url': url, 'html': ''}
                body = raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
                return {'status': 'ok', 'url': response.url, 'html': body}
        except HTTPError as exc:
            if exc.code in (401, 403, 429):
                return {'status': 'browser_required', 'reason': 'http_' + str(exc.code), 'url': url, 'html': ''}
            if attempt:
                return {'status': 'fetch_failed', 'reason': 'http_' + str(exc.code), 'url': url, 'html': ''}
        except (OSError, URLError, HTTPException, ValueError):
            if attempt:
                return {'status': 'fetch_failed', 'reason': 'network', 'url': url, 'html': ''}
    raise AssertionError('unreachable')


class Page(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.texts, self.fields, self.links = [], [], []
        self.hidden = 0
        self.label = None
        self.labels = {}
        self.link = None
        self.current = None
        self.option = None
        self.feed(source)
        for f in self.fields:
            f['label'] = self.labels.get(f.get('id'), f.get('label', ''))
        self.text = ' '.join(self.texts)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('script', 'style'):
            self.hidden += 1
        if tag == 'label':
            self.label = a.get('for', '')
        if tag in ('input', 'textarea', 'select') and a.get('type', '') not in ('hidden', 'submit', 'button'):
            f = dict(a, ref='html-' + str(len(self.fields)), label=a.get('aria-label') or a.get('placeholder') or a.get('name') or '', inputType=a.get('type', tag), role='combobox' if tag == 'select' else 'textbox')
            self.fields.append(f)
            self.current = f
        if tag == 'option' and self.current:
            self.option = {'value': a.get('value', ''), 'text': ''}
            self.current.setdefault('options', []).append(self.option)
        if tag == 'a' and 'href' in a:
            self.link = {'raw_href': a['href'], 'rel': a.get('rel', ''), 'anchor_text': ''}
            self.links.append(self.link)

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.hidden = max(0, self.hidden - 1)
        if tag == 'label':
            self.label = None
        if tag == 'a':
            self.link = None
        if tag == 'option':
            self.option = None
        if tag in ('select', 'textarea'):
            self.current = None

    def handle_data(self, data):
        if self.hidden:
            return
        text = data.strip()
        if text:
            self.texts.append(text)
        if self.label is not None:
            self.labels[self.label] = (self.labels.get(self.label, '') + ' ' + text).strip()
        if self.link is not None:
            self.link['anchor_text'] += data
        if self.option is not None:
            self.option['text'] += data


def unwrap(snapshot):
    while isinstance(snapshot, dict):
        key = next((k for k in ('result', 'data', 'snapshot') if isinstance(snapshot.get(k), dict)), None)
        if not key:
            break
        snapshot = snapshot[key]
    return snapshot


def snapshot_fields(snapshot):
    snapshot = unwrap(snapshot)
    items = snapshot.get('fields') or snapshot.get('items', [])
    forms = snapshot.get('forms', [])
    result = []
    for raw in items:
        f = dict(raw)
        if f.get('role') not in ('textbox', 'combobox', 'searchbox', 'spinbutton') and not f.get('inputType') and not f.get('type'):
            continue
        f['label'] = f.get('label') or f.get('name', '')
        # sourceRef 与动作 ref 是不同命名空间，只用唯一标签关联。
        matches = [x for x in forms if x.get('label') == f['label']]
        if len(matches) == 1:
            f = {**matches[0], **f}
        result.append(f)
    return result


def hits(text, patterns):
    result = []
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            result.append(text[max(0, match.start()-35):match.end()+55])
    return result


def fresh_dr(row, now=None):
    now = now or today()
    try:
        value = float(row.get('dr', ''))
        stamp = day(row.get('dr_date'))
        return math.isfinite(value) and 0 <= value <= 100 and stamp is not None and 0 <= (now-stamp).days <= rules('policy')['dr_days']
    except (ValueError, TypeError):
        return False


def enrich_dr(rows, script, offline=False, conf_dr_cache=None):
    missing = list(dict.fromkeys(domain(r.get('domain') or r.get('source_domain', '')) for r in rows if not fresh_dr(r)))
    if not missing:
        return
    if offline:
        return
    # 复用原脚本；缓存默认与原脚本共用，config 可用 dr_cache 改位置。
    spec = importlib.util.spec_from_file_location('bk_ahrefs', script)
    mod = importlib.util.module_from_spec(spec)
    import sys
    bytecode_setting=sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode=True
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode=bytecode_setting
    if conf_dr_cache:
        mod.CACHE_PATH = Path(conf_dr_cache)
    from types import SimpleNamespace
    stream, errors = io.StringIO(), io.StringIO()
    from contextlib import redirect_stdout, redirect_stderr
    with redirect_stdout(stream), redirect_stderr(errors):
        key = mod.load_key()
        if not key:
            raise ValueError('Ahrefs code=no_key；停止整批，不生成队列')
        status = mod.run(SimpleNamespace(domains=missing, file=None, selftest=False, refresh=False, json=True), key)
    codes = re.findall(r'code=(\w+)', errors.getvalue())
    if status or any(c in rules('policy')['stop_codes'] for c in codes):
        raise ValueError('Ahrefs 停止：' + ','.join(codes or ['query_failed']))
    metrics = {x['domain']: x for x in json.loads(stream.getvalue())}
    for row in rows:
        m = metrics.get(domain(row.get('domain') or row.get('source_domain', '')))
        if m:
            row.update(dr=str(m['dr']), dr_date=m['checked_date'])


def screen(source, url='', metadata=None, snapshot=False):
    metadata = metadata or {}
    kw, policy = rules('keywords'), rules('policy')
    if snapshot:
        snap = unwrap(source)
        # capture 产出的 fields 已合并 maxlength/选项，优先使用。
        fields = snap.get('fields') or snapshot_fields(snap)
        text = ' '.join([snap.get('text', ''), snap.get('title', ''), *[i.get('name', '') for i in snap.get('items', [])], *[f.get('label', '') for f in fields]])
    else:
        p = Page(source)
        fields, text = p.fields, p.text
    signals = {k: hits(text, v) for k, v in kw['signals'].items()}
    # 明确否定回链和收费要求优先消歧；未出现要求仍不能当作确认无要求。
    if signals['no_backlink']:
        signals['backlink_required'] = [x for x in signals['backlink_required'] if not hits(x, kw['signals']['no_backlink'])]
    if signals['free']:
        signals['paid'] = [x for x in signals['paid'] if not hits(x, kw['signals']['free'])]
    scenario = next((k for k,v in kw['scenarios'].items() if hits(url+' '+text, [re.escape(x) for x in v])), 'unknown')
    if signals['paid']:
        scenario = 'paid'
    fit = [s for s,v in kw['fit'].items() if hits(text, [re.escape(x) for x in v])]
    old_fit = [s for s in kw['fit'] if s in metadata.get('fit_sites', '').lower()]
    fit = sorted(set(fit + old_fit))
    password = any(sensitive(f) == 'password' for f in fields)
    # 表单里出现验证码/手机/所有权验证控件，等同页面验证信号。
    kinds = {sensitive(f) for f in fields}
    if kinds & {'captcha', 'phone'}:
        signals['captcha'] = signals['captcha'] or ['form field: ' + ','.join(sorted(kinds & {'captcha', 'phone'}))]
    if 'ownership' in kinds:
        signals['upload_verify'] = signals['upload_verify'] or ['form field: ownership']
    result = dict(domain=domain(metadata.get('domain') or url), form_host=domain(url), submit_url=url, scenario=scenario, cost='paid' if signals['paid'] else 'free' if signals['free'] else 'UNKNOWN', login=bool(signals['login'] or password), captcha=bool(signals['captcha']), backlink_required=True if signals['backlink_required'] else False if signals['no_backlink'] else 'UNKNOWN', upload_verify=bool(signals['upload_verify']), email_verify=bool(signals['email_verify']), license_risk=bool(signals['license_risk']), automation_forbidden=bool(signals.get('automation_forbidden')), fields=[{k:f[k] for k in ('ref','label','inputType','maxlength','options') if k in f} for f in fields], fit_sites='|'.join(fit), dr=metadata.get('dr','UNKNOWN'), dr_date=metadata.get('dr_date','UNKNOWN'), last_verified=str(today()))
    reasons = [k + ': ' + quote for k, quotes in signals.items() for quote in quotes]
    reasons += ['scenario '+scenario+': '+quote for quote in hits(url+' '+text,[re.escape(x) for x in kw['scenarios'].get(scenario,[])])]
    action = policy['scenarios'].get(scenario)
    if action == 'forbidden' or result['license_risk'] or result['automation_forbidden'] or result['backlink_required'] is True:
        conclusion = '不做'
    elif any(result[k] for k in ('captcha','email_verify','upload_verify')) or password:
        conclusion = '待饼哥'
        if password:
            reasons.append('user_input_required: password')
    elif action == 'approval':
        conclusion = '需批准'
        result['draft_status'] = 'drafted'
    elif action == 'outreach':
        conclusion = '可投' if signals['contact'] and fit and fresh_dr(result) and float(result['dr']) >= policy['dr_min'] and result['cost'] != 'paid' else '待核实'
    elif action == 'preapproved' and fields and result['cost'] == 'free' and result['backlink_required'] is False and fit and fresh_dr(result) and float(result['dr']) >= policy['dr_min']:
        conclusion = '可投'
    else:
        conclusion = '待核实'
    browser = bool(signals['js']) or (not snapshot and bool(hits(source,kw['signals']['js_shell']))) or (not fields and action == 'preapproved') or len(text.strip()) < 40
    if browser and conclusion == '可投':
        conclusion = '待核实'
    result['login_method']='Google' if re.search(r'(?:sign in|log ?in|continue|sign up).{0,20}google|google.{0,20}(?:sign in|log ?in)',text,re.I) else '邮箱注册' if password else 'UNKNOWN' if result['login'] else '无'
    result.update(status=conclusion, reasons=reasons + ([] if conclusion in ('可投','不做','待饼哥','需批准') else ['准入证据不完整：须核免费、无强制回链、主题、表单及有效 DR']), browser_required=browser, observation='ok')
    return result


def semantic_key(field):
    if field.get('key') in set(rules('labels')) | {'label'}:
        return field['key']
    label = (field.get('label') or field.get('name') or '').lower().strip()
    if re.search(r'\b(first|last|contact) name\b', label):
        return None
    if re.search(r'\b(url|web\s*site|homepage|domain)\b', label):
        return 'url'
    if re.search(r'e[ -]?mail', label):
        return 'email'
    matches = [(len(alias), key) for key, aliases in rules('labels').items() for alias in aliases if alias in label]
    return max(matches)[1] if matches else None


def sensitive(field):
    text = ' '.join(str(field.get(k, '')) for k in ('key','label','name','inputType','type','fieldKind','autocomplete')).lower()
    for key, words in rules('keywords')['sensitive'].items():
        if any(word in text for word in words):
            return key
    return None


def compile_kit(source):
    text = Path(source).read_text()
    kit = {'source': str(source), 'fields': {}, 'images': []}
    for line in text.splitlines():
        m = re.match(r'- (.+?)(?:（[^）]*）)?：(.*)', line)
        if not m:
            continue
        label, value = m[1], m[2].strip()
        key = rules('kit-fields').get(label)
        if key:
            kit['fields'][key] = {'value': value, 'length': len(value)}
        image = re.match(r'(Logo|首页截图)\s*(\d+)[×x](\d+)', label)
        if image:
            kit['images'].append(dict(key='logo' if image[1]=='Logo' else 'screenshot', path=value, width=int(image[2]), height=int(image[3])))
    return kit


def check_kit(kit):
    errors = []
    for key in rules('kit-fields').values():
        field = kit['fields'].get(key)
        if not field or not field.get('value') or field['length'] != len(field['value']):
            errors.append(key + ': 缺失或长度不一致')
    for key, limit in [('tagline',60),('short_description',160),('description',500)]:
        if len(kit['fields'].get(key,{}).get('value','')) > limit:
            errors.append(key + ': 超长')
    for key in ('logo','screenshot'):
        if not any(i['key']==key for i in kit['images']):
            errors.append(key + ': 缺失')
    for image in kit['images']:
        try:
            with Path(image['path']).open('rb') as f:
                head = f.read(24)
            if head[:8] != b'\x89PNG\r\n\x1a\n' or head[12:16] != b'IHDR' or struct.unpack('>II',head[16:24]) != (image['width'],image['height']):
                errors.append(image['path'] + ': PNG 尺寸或格式错误')
        except OSError:
            errors.append(image['path'] + ': 文件不存在')
    return errors


def kit_text(kit, key, limit=None):
    """从 v1/v2 资料包里取字段文本；v2 有分档时按上限挑最长可用版本。"""
    from . import kits as kits_module
    field = (kit.get('fields') or {}).get(key)
    if field is None:
        return None
    return kits_module.pick_variant(field, limit=limit)


def fillplan(snapshot, kit, saved_fields=None):
    fields = snapshot_fields(snapshot)
    plan = []
    saved = saved_fields or []
    for f in fields:
        if f.get('disabled') or f.get('readonly'):
            continue
        key, block = semantic_key(f), sensitive(f)
        # 按原标签保存的值优先（含脚本不认识的字段和人工选的下拉项）。
        exact = [s for s in saved if s.get('label') == f['label']]
        if len(exact) == 1 and not block:
            key = exact[0].get('key') or 'label'
        entry = dict(ref=f.get('ref',''), key=key or 'unmatched', label=f['label'], action='stop', reason='', value=None)
        if block:
            entry.update(key=block, reason='user_input_required: '+block)
        elif f.get('disabled') or f.get('readonly'):
            entry['reason'] = '字段不可编辑'
        elif not key:
            entry['reason'] = '未识别字段，需人工备料'
        else:
            candidates = exact if len(exact) == 1 else [s for s in saved if s.get('key') == key]
            multiple = len(candidates)>1
            if multiple:
                candidates = [s for s in candidates if s.get('label') == f['label']]
            # 有保存值用保存值；没保存的字段回退到资料包。
            use_saved = len(candidates)==1
            if multiple and len(candidates)!=1:
                entry['reason'] = '保存的字段语义不唯一'
            else:
                value = candidates[0]['value'] if use_saved else kit_text(kit, key)
                if key in ('logo','screenshot'):
                    images = [i for i in kit['images'] if i['key']==key]
                    value = candidates[0]['value'] if use_saved else images[0]['path'] if images else None
                    entry.update(action='files.upload', selector=f.get('selector',''))
                    if not entry['selector']:
                        entry.update(action='stop', reason='上传控件缺少已核对的唯一 selector')
                elif f.get('options') or f.get('role') == 'combobox':
                    values = [o if isinstance(o,str) else o.get('text',o.get('label','')) for o in f.get('options',[])]
                    same = [o for o in values if o.strip() == str(value or '').strip()]
                    choices = re.split(r'\s*/\s*|,\s*|（', str(value or ''))
                    scored = [(max((len(set(re.findall(r'\w+',o.lower())) & set(re.findall(r'\w+',c.lower()))) / max(1,len(set(re.findall(r'\w+',o.lower())))) for c in choices),default=0),o) for o in values if o.strip()]
                    scored.sort(reverse=True)
                    if len(same) == 1:
                        value = same[0]
                        entry['action']='select'
                    elif scored and scored[0][0] > 0 and (len(scored)==1 or scored[0][0]>scored[1][0]):
                        value = scored[0][1]
                        entry['action']='select'
                    else:
                        entry['reason']='下拉选项无唯一贴切项'
                else:
                    entry['action']='ref_fill'
                    limit = f.get('maxlength', f.get('maxLength'))
                    if key in ('description','short_description','tagline') and limit is not None and not use_saved:
                        candidates_text = [kit_text(kit, k, limit=limit) for k in ('description','short_description','tagline')]
                        valid = [v for v in candidates_text if v and (limit is None or int(limit)<0 or len(v)<=int(limit))]
                        value = max(valid,key=len) if valid else None
                    if value is not None and limit is not None and int(limit)>=0 and len(str(value))>int(limit):
                        value=None
                if value is None or value=='':
                    entry.update(action='stop', reason='没有能完整放下的资料版本')
                if key in ('subject','message') and re.search(r'\{[^}]+\}',str(value)):
                    entry.update(action='stop',reason='外联草稿仍有占位符；须按页面补全后重做方案')
                if not entry['reason']:
                    entry['reason']='按标签语义 '+key+' 匹配资料与约束'
                entry['value']=value
        plan.append(entry)
    snap=unwrap(snapshot)
    context=' '.join([snap.get('text',''),snap.get('title',''),*[x.get('name','') for x in snap.get('items',[])]])
    for signal in ('captcha','email_verify','upload_verify'):
        evidence=hits(context,rules('keywords')['signals'][signal])
        if evidence and not any(x['key']==signal for x in plan):
            plan.append(dict(ref='',key=signal,label=signal,action='stop',value=None,reason='user_input_required: '+evidence[0]))
    return {'status':'user_input_required' if not plan or any(x['action']=='stop' for x in plan) else 'ready', 'items':plan}


def make_queue(directories, ledger, conf, offline=False):
    from . import kits as kits_module
    candidates = [dict(r) for r in directories if r.get('status')=='可投']
    enrich_dr(candidates, conf['ahrefs_script'], offline)
    queue, seen = [], set()
    policy = rules('policy')
    for row in candidates:
        if not fresh_dr(row) or float(row['dr'])<policy['dr_min']:
            continue
        scenario = row.get('scenario') or screen('<p>'+html.escape(' '.join(row.get(k,'') for k in ('notes','categories','fields')))+'</p>',row.get('submit_url',''),row)['scenario']
        if scenario=='unknown':
            scenario='directory'
        # 资产表的可投行已审核；从旧证据恢复渠道，未知渠道按目录资产处理。
        if policy['scenarios'].get(scenario) not in ('preapproved','outreach'):
            continue
        for site in conf['sites']:
            if site not in row.get('fit_sites','').lower():
                continue
            pair = (domain(row['domain']),site)
            history = [r for r in ledger if domain(r['source_domain'])==pair[0] and site in r['site'].lower()]
            excluded = any(r.get('status','').lower() in policy['queue_exclude'] or (r.get('status','').lower()=='blocked' and (not day(r.get('last_checked_at') or r.get('submitted_at')) or (today()-day(r.get('last_checked_at') or r.get('submitted_at'))).days <= policy['blocked_days'])) for r in history)
            if pair in seen or excluded:
                continue
            seen.add(pair)
            kit, _ = kits_module.load(conf, site)
            queue.append(dict(source_domain=pair[0],site=site,scenario=scenario,submit_url=row['submit_url'],target_url=kits_module.text_of(kit['fields'].get('url')),dr=row['dr'],dr_date=row['dr_date'],status='queued'))
    return sorted(queue,key=lambda r:float(r['dr']),reverse=True)


def interval(row):
    p = rules('policy')['verify_days']
    return p.get(row.get('status','').lower(),p.get(row.get('channel_type','').lower(),p['default']))


def due(row, now=None):
    now=now or today()
    if row.get('status','').lower() not in ('submitted','pending','public','alive','live','unknown'):
        return False
    if row.get('status','').lower() == 'unknown' and not (day(row.get('submitted_at')) or day(row.get('first_public_at')) or row.get('raw_href') not in (None, '', 'UNKNOWN')):
        return False
    deadline = day(row.get('next_check_at'))
    if deadline:
        return deadline<=now
    stamp=day(row.get('last_checked_at')) or day(row.get('submitted_at')) or day(row.get('first_public_at'))
    return bool(stamp and stamp+timedelta(days=interval(row))<=now)


def verify_row(row, response, sites, now=None):
    now=now or today()
    result=dict(row)
    result['last_checked_at']=str(now)
    result['next_check_at']=str(now+timedelta(days=interval(row)))
    if response['status']!='ok':
        result.update(status='unknown',observation=response['status'])
        append_note(result,'bk:absence=0；来源读取失败，不计为缺链')
        return result
    page=Page(response['html'])
    signals=rules('keywords')['signals']
    js=hits(page.text,signals['js']) or hits(page.text,signals['login']) or hits(response['html'],signals['js_shell']) or len(page.text.strip())<20
    if js:
        result.update(observation='browser_required')
        append_note(result,'bk:absence=0；需浏览器补核，不计为缺链')
        return result
    expected=sites.get(row.get('site','').lower().replace('.tools',''),{}).get('domain') or domain(row.get('target_url',''))
    links=[a for a in page.links if domain(urljoin(response['url'],a['raw_href']))==expected and expected in {s['domain'] for s in sites.values()}]
    if links:
        result.update(links[0],status='public',observation='link_found',next_check_at=str(now+timedelta(days=28)))
        if not day(row.get('first_public_at')):
            result['first_public_at']=str(now)
        append_note(result,'bk:absence=0')
    else:
        # 仅对曾公开且原 URL 未跳转、保存过位置证据的记录计连续缺失。
        same= response['url'].rstrip('/')==row.get('source_url','').rstrip('/')
        previous=re.findall(r'bk:absence=(\d+)',row.get('notes',''))
        count=int(previous[-1]) if previous else 0
        established=bool(day(row.get('first_public_at')) or row.get('status','').lower() in ('public','alive','live'))
        count=count+1 if established and same and row.get('raw_href') not in ('','UNKNOWN',None) else 0
        if count>=2:
            result['status']='removed'
        append_note(result,'bk:absence='+str(count))
        result['observation']='link_absent'
    return result


def outreach_drafts(queue, ledger, kits, template, now=None):
    from . import kits as kits_module
    now=now or today()
    policy=rules('policy')
    sent=[r for r in ledger if r.get('channel_type') in ('outreach','contact','form','roundup','resource') and (day(r.get('submitted_at')) or r.get('status','').lower() in ('submitted','public','alive','live','unknown'))]
    used={domain(r['source_domain']) for r in sent}
    if any(not day(r.get('submitted_at')) for r in sent):
        raise ValueError('外联历史有发送日期未知的记录，无法证明每日上限；先人工补核日期')
    remaining=max(0,policy['daily_outreach']-sum(day(r.get('submitted_at'))==now for r in sent))
    result=[]
    for row in queue:
        if not fresh_dr(row) or float(row['dr'])<policy['dr_min']:
            continue
        d=domain(row['source_domain'])
        if policy['scenarios'].get(row.get('scenario'))!='outreach' or d in used or not remaining:
            continue
        kit = kits[row['site']]
        kit = kit if isinstance(kit, dict) and 'fields' in kit else kit.get('fields', {})
        fields = kit['fields'] if 'fields' in kit else kit
        text = lambda key: kits_module.text_of(fields.get(key))
        # 模板称 free，只有资料明确 Free 才生成；Freemium 需人工确认合适免费目标页。
        if text('pricing').split('（')[0].strip().lower()!='free':
            continue
        replacements={'page_title':row.get('page_title','{page_title}'),'page_url':row.get('submit_url','{page_url}'),'name_or_there':'there','topic':row.get('topic','{topic}'),'product_name':text('name'),'target_url':text('url'),'one_line_what_it_does':text('tagline'),'product_domain':domain(text('url'))}
        body=template
        for key,value in replacements.items():
            body=body.replace('{'+key+'}',value)
        result.append({'source_domain':d,'site':row['site'],'status':'drafted','body':body})
        used.add(d);remaining-=1
    return result
