"""持久待验证存档：复用 handoff 与来源库，不把短期快照当长期资产。"""
from copy import deepcopy
import fcntl
import json
import re
import uuid
from urllib.parse import urlsplit

from .core import sensitive, rules
from .handoff import stamp
from .sources import submitted

ACTIVE = ('待处理', '待授权', '待人工')
LOCATOR_KEYS = ('name', 'id', 'label', 'autocomplete', 'inputType', 'widget', 'platformId', 'index', 'path')


def clean_url(value):
    if not isinstance(value, str):
        raise ValueError('invalid_archive_url')
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('invalid_archive_url')
    return value


def clean_frame(frame, site, source):
    """只接收复原需要的字段；敏感值连同伪造的嵌套属性一并丢弃。"""
    if not isinstance(frame, dict):
        raise ValueError('invalid_archive_frame')
    steps = frame.get('steps')
    if not isinstance(steps, list) or not 0 < len(steps) <= 50:
        raise ValueError('invalid_archive_steps')
    result: dict = dict(url=clean_url(frame.get('url', '')), site=site, source_domain=source,
                  step_index=frame.get('step_index', 0), complete=False,
                  has_next=bool(frame.get('has_next')), verification=bool(frame.get('verification')), steps=[])
    if type(result['step_index']) is not int or not 0 <= result['step_index'] < len(steps):
        raise ValueError('invalid_archive_step')
    for step in steps:
        if not isinstance(step, dict):
            raise ValueError('invalid_archive_step')
        fields = step.get('fields')
        if not isinstance(fields, list) or len(fields) > 1000:
            raise ValueError('invalid_archive_fields')
        clean = []
        for field in fields:
            if not isinstance(field, dict) or not isinstance(field.get('locator', {}), dict):
                raise ValueError('invalid_archive_field')
            locator = field.get('locator') or {}
            item = {key: deepcopy(field[key]) for key in
                    ('label', 'key', 'inputType', 'widget', 'order', 'required', 'asset_id', 'asset_sha256', 'needs_confirmation') if key in field}
            item['locator'] = {key: locator[key] for key in LOCATOR_KEYS if key in locator}
            blocked = sensitive({**item, 'name': locator.get('name', '')}) or field.get('skipped')
            if item.get('key') in rules('keywords')['sensitive']:
                blocked = item['key']
            if item.get('inputType') in ('checkbox', 'radio') and re.search(
                    r'agree|accept|terms|privacy|consent|条款|同意|授权|subscribe|newsletter|opt.?in', item.get('label', ''), re.I):
                blocked = 'sensitive'
            if blocked:
                item['skipped'] = 'captcha' if blocked in ('captcha', 'verification') else 'sensitive'
            else:
                value = field.get('value', '')
                if not isinstance(value, (str, bool)):
                    raise ValueError('invalid_archive_value')
                item['value'] = value
                if isinstance(field.get('checked'), bool):
                    item['checked'] = field['checked']
            clean.append(item)
        result['steps'].append({'fields': clean})
    return result


def summary(frames):
    fields = [field for frame in frames for step in frame['steps'] for field in step['fields']]
    missing = [field.get('label', '') for field in fields if not field.get('skipped') and
               (field.get('needs_confirmation') or
                (not field.get('asset_id') or not field.get('asset_sha256') if field.get('inputType') == 'file' else field.get('value') in ('', None, False)))]
    other = [field.get('label', '') for field in fields if field.get('skipped') == 'sensitive' and field.get('required')]
    multistep = any(len(frame['steps']) > 1 or frame['has_next'] for frame in frames)
    verification = any(frame['verification'] for frame in frames) or any(field.get('skipped') == 'captcha' for field in fields)
    return dict(only_verification=verification and not missing and not other and not multistep,
                saved_fields=sum(not field.get('skipped') and (bool(field.get('value')) or bool(field.get('asset_id'))) for field in fields),
                remaining=missing + other, multistep=multistep, verification=verification)


def save(api, data):
    site, url = data.get('site'), clean_url(data.get('url', ''))
    context = api.context(site, url)
    source = context['source_domain']
    raw = data.get('frames')
    if not isinstance(raw, list) or not 0 < len(raw) <= 50 or len(json.dumps(raw)) > 2_000_000:
        raise ValueError('invalid_archive_frames')
    frames = [clean_frame(frame, site, source) for frame in raw]
    if not any(any(step['fields'] for step in frame['steps']) for frame in frames):
        raise ValueError('没有可存档的字段')
    from .core import read_csv
    if submitted(api.library.load(source), site, read_csv(api.conf['ledger'])[1]):
        raise ValueError('已有提交或未知结果，不能重新排队')
    with (api.store.root / '.archive.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        existing = [row for row in api.store.rows() if row['site'] == site and row['submit_url'] == url]
        record = next((row for row in existing if row['status'] in ACTIVE), None)
        if existing and record is None:
            raise ValueError('已有终态或未知结果，先核实，不重复存档')
        ident = record['id'] if record else uuid.uuid4().hex
        with api.store.lock(ident):
            record = api.store.load(ident) if record else dict(id=ident, created_at=stamp(), steps=[], fields=[], step=0)
            if record.get('status', '待人工') not in ACTIVE:
                raise ValueError('存档状态已改变，请刷新后核实')
            details = summary(frames)
            record.update(site=site, source_domain=source, submit_url=url, status='待人工',
                          blocker='人工验证', blocker_location='存档页面',
                          archive={**details, 'saved_at': stamp(), 'frames': frames},
                          message='仅剩人工验证' if details['only_verification'] else '已存档；复原后请核对剩余项')
            api.store.save(record)
            steps = [step for frame in frames for step in frame['steps']]
            api.remember(context, {'steps': steps, 'complete': False})
    return {'id': ident, 'status': record['status'], 'archive': details}
