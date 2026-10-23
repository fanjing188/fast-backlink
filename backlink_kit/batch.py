"""持久批量任务；来源锁同时保护资格检查、任务领取和记账。"""
from collections import Counter
from contextlib import contextmanager
from datetime import datetime
import json
from pathlib import Path
import re
import time
import uuid

from . import core as c, sources as s, handoff, kits, library_v2 as v2

RESULTS = ('success', 'manual', 'unknown', 'failed', 'abandoned', 'cancelled')
ACTIVE = ('queued', 'running', 'manual', 'unknown')


class BatchStore:
    def __init__(self, conf):
        self.conf = conf
        self.root = Path(conf['runs_dir']) / 'batches'
        self.sources = s.SourceStore(conf['sources_dir'])

    def path(self, ident):
        if not isinstance(ident, str) or not re.fullmatch('[0-9a-f]{32}', ident):
            raise ValueError('invalid_batch_id')
        return self.root / (ident + '.json')

    def rows(self):
        return [json.loads(p.read_text()) for p in sorted(self.root.glob('*.json'))]

    def load(self, ident):
        return json.loads(self.path(ident).read_text())

    def save(self, batch):
        c.atomic_json(self.path(batch['id']), batch)

    def history(self):
        rows = []
        for batch in self.rows():
            for job in batch['jobs']:
                unknown = bool(job.get('attempted_at')) and job['state'] not in ('success', 'failed')
                if job['state'] in (*ACTIVE, 'success') or unknown:
                    rows.append(dict(source_domain=job['domain'], site=batch['site'],
                                     status='submitted' if job['state'] == 'success' else '结果未知' if unknown else '待人工',
                                     submitted_at=job.get('finished_at', ''), id=job['id']))
        return rows

    def preview(self, data):
        from .library import history_rows, usable_urls
        site = data.get('site')
        if site not in self.conf['sites']:
            raise ValueError('select_product')
        kit, _ = kits.load(self.conf, site)
        profile = kits.profile(self.conf)
        missing = [key for key in ('name', 'url', 'tagline', 'short_description', 'description', 'email')
                   if not (c.kit_text(kit, key) or c.kit_text(profile, key))]
        names = v2.selected(self.conf, data)
        rows, eligible, skipped = history_rows(self.conf), [], []
        for name in names:
            record = self.sources.load(name)
            fee = v2.normalize_fee(record['gates'].get('fee', {}).get('value'))
            kind = v2.normalize_type(s.basic(record, 'scenario'))
            dr = dict(dr=s.basic(record, 'dr'), dr_date=s.basic(record, 'dr_date'))
            state = v2.submissions(record, rows, site)['submission_status']
            urls = usable_urls(record)
            reason = ''
            if state != 'unsubmitted':
                reason = '该产品已提交或处理中'
            elif fee not in ('free', 'freemium'):
                reason = '付费或费用未知'
            elif kind not in ('directory', 'launch', 'resource', 'roundup', 'other'):
                reason = '类型需要批准或未分类'
            elif not c.fresh_dr(dr) or float(dr['dr']) < c.rules('policy')['dr_min']:
                reason = '没有有效 DR 或 DR<10；先刷新 DR'
            elif not urls:
                reason = '没有安全直达链接'
            elif missing:
                reason = '产品资料缺必填项：' + ', '.join(missing)
            elif record['admission'].get('value') == '不做' or any(record['gates'].get(k, {}).get('value') in (True, 'true', 'True', '是') for k in ('automation', 'license', 'backlink')):
                reason = '平台限制或回链要求未通过'
            if reason:
                skipped.append(dict(domain=name, reason=reason))
            else:
                eligible.append(dict(domain=name, url=urls[0], dr=float(dr['dr'])))
        eligible.sort(key=lambda r: (-r['dr'], r['domain']))
        return dict(site=site, eligible=eligible, skipped=skipped)

    def start(self, data):
        size = data.get('batch_size', 10)
        if type(size) is not int or not 5 <= size <= 20:
            raise ValueError('batch_size_must_be_5_to_20')
        with self.sources.lock():
            preview = self.preview(data)
            if not preview['eligible']:
                raise ValueError('no_eligible_platforms')
            batch = dict(id=uuid.uuid4().hex, site=preview['site'], batch_size=size, state='running',
                         created_at=handoff.stamp(), skipped=preview['skipped'], jobs=[])
            for index, row in enumerate(preview['eligible']):
                batch['jobs'].append(dict(**row, id=uuid.uuid4().hex, state='queued', group=index // size + 1, reason=''))
            self.save(batch)
            return self.view(batch)

    def view(self, batch):
        counts = Counter(j['state'] for j in batch['jobs'])
        return dict(batch, counts={key: counts[key] for key in ('queued', 'running', *RESULTS)},
                    group=next((j['group'] for j in batch['jobs'] if j['state'] in ('queued', 'running')), max((j['group'] for j in batch['jobs']), default=0)),
                    groups=max((j['group'] for j in batch['jobs']), default=0))

    def status(self, ident=None):
        return self.view(self.load(ident)) if ident else [self.view(b) for b in self.rows()]

    def control(self, data):
        action = data.get('action')
        if action not in ('pause', 'resume', 'stop'):
            raise ValueError('invalid_batch_control')
        with self.sources.lock():
            batch = self.load(data['id'])
            if action == 'resume' and batch['state'] not in ('paused', 'running'):
                raise ValueError('batch_not_resumable')
            batch['state'] = dict(pause='paused', resume='running', stop='stopped')[action]
            if action == 'stop':
                for job in batch['jobs']:
                    if job['state'] == 'queued':
                        job.update(state='cancelled', reason='用户停止')
            self.save(batch)
            self.finish(batch)
            return self.view(batch)

    def claim(self, data):
        owner = data.get('owner')
        if not isinstance(owner, str) or not re.fullmatch('[0-9a-f]{32}', owner):
            raise ValueError('invalid_executor')
        with self.sources.lock():
            jobs = []
            for batch in self.rows():
                for job in batch['jobs']:
                    if job['state'] in RESULTS and not job.get('committed'):
                        self.update_handoff(job, batch)
                        if job['state'] == 'success':
                            self.ledger(job, batch)
                        job['committed'] = True
                    if job['state'] == 'running' and time.time() - job['started'] >= 180:
                        job.update(state='unknown', reason='单页超过3分钟或执行器中断；禁止自动重试', finished_at=handoff.stamp())
                        self.update_handoff(job, batch)
                if batch['state'] == 'running' and not any(j['state'] == 'running' for j in batch['jobs']):
                    queued = [j for j in batch['jobs'] if j['state'] == 'queued']
                    group = queued[0]['group'] if queued else None
                    for job in queued:
                        if job['group'] != group:
                            break
                        job.update(state='running', owner=owner, started=time.time(), lease=uuid.uuid4().hex)
                        self.update_handoff(job, batch)
                        jobs.append(dict(job, batch_id=batch['id'], site=batch['site']))
                self.save(batch)
                self.finish(batch)
            return jobs

    def update_handoff(self, job, batch, frames=None):
        store = handoff.Store(self.conf['handoff_dir'], self.conf)
        path = store.path(job['id'])
        record = store.load(job['id']) if path.exists() else dict(id=job['id'], created_at=handoff.stamp(), fields=[], steps=[], step=0)
        states = dict(running='待处理', manual='待人工', unknown='结果未知', success='submitted', failed='failed', abandoned='abandoned', cancelled='cancelled')
        record.update(source_domain=job['domain'], site=batch['site'], submit_url=job['url'],
                      status=states[job['state']], blocker=job.get('reason', ''), batch_id=batch['id'])
        if frames is not None:
            from .archives import clean_frame, summary
            clean = [clean_frame(f, batch['site'], job['domain']) for f in frames]
            if not clean or not any(step['fields'] for f in clean for step in f['steps']):
                raise ValueError('没有可存档字段；勿关标签')
            from .library import safe_url
            from urllib.parse import urlsplit
            top = [f for f in clean if f.get('frame_id') == 0]
            if not top and len(clean) == 1 and 'frame_id' not in clean[0]:
                top = clean
            if len(top) != 1 or urlsplit(safe_url(top[0]['url'])).netloc != urlsplit(job['url']).netloc:
                raise ValueError('无法安全确定存档的顶层页面；勿关标签')
            job['resume_url'] = top[0]['url']
            record['archive'] = dict(**summary(clean), saved_at=handoff.stamp(), frames=clean)
            job['archived_at'] = record['archive']['saved_at']
        record['submit_url'] = job.get('resume_url') or job['url']
        if job['state'] in ('success', 'abandoned'):
            record.pop('archive', None)
            job.pop('archived_at', None)
            job['archive_saved'] = False
        store.save(record)

    def find(self, batch, ident):
        job = next((j for j in batch['jobs'] if j['id'] == ident), None)
        if not job:
            raise ValueError('unknown_batch_job')
        return job

    def attempt(self, data):
        with self.sources.lock():
            batch = self.load(data['batch_id'])
            job = self.find(batch, data['id'])
            self.check_lease(job, data)
            if time.time() - job['started'] >= 180:
                job.update(state='unknown', reason='提交授权已过期；先核实，不自动重试', finished_at=handoff.stamp())
                self.save(batch)
                self.update_handoff(job, batch)
                raise ValueError('batch_lease_expired')
            if batch['state'] != 'running' or job.get('attempted_at'):
                raise ValueError('submission_not_authorized_or_already_attempted')
            from .library import history_rows
            # 领取后也可能出现其他提交回执；只排除本任务自身的运行占位。
            rows = [r for r in history_rows(self.conf) if r.get('id') != job['id']]
            record = self.sources.load(job['domain'])
            if v2.submissions(record, rows, batch['site'])['submission_status'] != 'unsubmitted':
                raise ValueError('submission_not_authorized_or_already_attempted')
            job['attempted_at'] = handoff.stamp()
            self.save(batch)
            return dict(authorized=True, id=job['id'])

    def manual_attempt(self, ident, job_id):
        with self.sources.lock():
            batch = self.load(ident)
            job = self.find(batch, job_id)
            if job['state'] == 'success':
                return {'status': 'submitted'}
            automatic = job['state'] == 'running' and bool(job.get('attempted_at'))
            job.setdefault('attempted_at', handoff.stamp())
            if not automatic:
                job.update(state='unknown', reason='检测到人工提交；先核实收稿结果，禁止重放', finished_at=handoff.stamp())
            self.save(batch)
            self.update_handoff(job, batch)
            self.finish(batch)
            return {'status': '待处理' if automatic else '结果未知'}

    def check_lease(self, job, data):
        if job['state'] != 'running' or job.get('owner') != data.get('owner') or job.get('lease') != data.get('lease'):
            raise ValueError('invalid_batch_lease')

    def result(self, data, manual=False):
        result = data.get('result')
        if result not in ('success', 'manual', 'unknown', 'failed') and not (manual and result == 'abandoned'):
            raise ValueError('invalid_batch_result')
        with self.sources.lock():
            batch = self.load(data['batch_id'])
            job = self.find(batch, data['id'])
            if job['state'] == result:
                return dict(job)
            if manual:
                if job['state'] not in ('manual', 'unknown') or result not in ('success', 'abandoned'):
                    raise ValueError('job_not_awaiting_manual')
            else:
                self.check_lease(job, data)
                if result == 'success' and not job.get('attempted_at'):
                    raise ValueError('success_requires_submission_attempt')
            job.update(state=result, reason=str(data.get('reason', ''))[:1000], finished_at=handoff.stamp())
            if result == 'manual':
                try:
                    self.update_handoff(job, batch, data.get('frames') or [])
                    job.update(archive_saved=True, archive_error='')
                except (ValueError, TypeError) as error:
                    job.update(archive_saved=False, archive_error=str(error))
                    self.update_handoff(job, batch)
            self.save(batch)
            if result != 'manual':
                self.update_handoff(job, batch)
            if result == 'success':
                self.ledger(job, batch)
            job['committed'] = True
            self.save(batch)
            self.finish(batch)
            return dict(job)

    def ledger(self, job, batch):
        path = Path(self.conf['ledger'])
        fields, rows = c.read_csv(path) if path.exists() else ([], [])
        if not any(r.get('record_id') == job['id'] for r in rows):
            row = dict(record_id=job['id'], source_domain=job['domain'], site=batch['site'], status='submitted', submitted_at=job['finished_at'])
            rows.append(row)
            c.output_csv(path, rows, s.unique(fields + list(row)))

    def finish(self, batch):
        if any(j['state'] in ('queued', 'running') for j in batch['jobs']):
            return
        if batch['state'] != 'stopped':
            batch['state'] = 'finished'
        self.save(batch)
        data = dict(domains=[j['domain'] for j in batch['jobs']], site=batch['site'])
        rows = v2.export_rows(self.conf, data)
        for row, job in zip(rows, batch['jobs']):
            row.update(result=job['state'], reason=job['reason'])
        path = Path(self.conf['runs_dir']) / batch['created_at'][:10] / ('batch-' + batch['id'] + '.csv')
        if c.protected(path):
            raise ValueError('真实数据只读；禁止写入')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(v2.csv_text(rows, v2.EXPORT_FIELDS + ['result', 'reason']), encoding='utf-8')
