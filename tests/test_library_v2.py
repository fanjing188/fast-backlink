"""v2 的纯数据口径和隔离后端回归；真实来源库受既有测试保护。"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
import json
import subprocess
import sys
import time

from backlink_kit import core as c, sources as s, kits, library, library_v2 as v2
from backlink_kit.batch import BatchStore
from tests.support import fixture_config


class PureLibraryV2Tests(TestCase):
    def test_normalization_preserves_unknowns(self):
        for raw, expected in [('免费 Premium', 'freemium'), ('0；仅URL/email搜索索引申请', 'free'),
                              ('Regular free; Featured 9.99 USD optional', 'freemium'),
                              ('Listing最低29.99 USD', 'paid'), ('UNKNOWN', 'unknown'), ('投稿需5 credits', 'unknown')]:
            self.assertEqual(v2.normalize_fee(raw), expected)
        self.assertEqual(v2.normalize_type('outreach'), 'other')
        self.assertEqual(v2.normalize_type('目录'), 'directory')
        self.assertEqual(v2.normalize_type('UNKNOWN'), '')

    def test_submission_count_is_distinct_products_and_unknown_is_processing(self):
        record = s.new_source('fixture.example')
        rows = [dict(source_domain='fixture.example', site=site, status=status, submitted_at='2026-10-20')
                for site, status in [('alpha','submitted'),('alpha','public'),('beta','live'),('gamma','unknown'),('delta','待核实')]]
        self.assertEqual(v2.submissions(record, rows, 'gamma')['submission_status'], 'processing')
        self.assertEqual(v2.submissions(record, rows, 'alpha')['submission_status'], 'submitted')
        self.assertEqual(v2.submissions(record, rows, 'new')['submission_status'], 'unsubmitted')
        self.assertEqual(v2.submissions(record, rows)['submit_count'], 2)
        self.assertEqual(v2.submissions(record, rows)['submission_status'], 'submitted')

    def test_pagination_filters_sort_and_validation(self):
        rows = [dict(domain=str(i)+'.example', dr=i, fee='free', submission_status='unsubmitted', submit_count=i,
                     last_submitted_at='') for i in range(120)]
        value, _ = v2.paginate(rows, {'page':2,'page_size':20,'dr_max':'99','dr_min':'10'})
        self.assertEqual(value['total'],90)
        self.assertEqual([r['dr'] for r in value['items']], list(range(79,59,-1)))
        for query in ({'page':0},{'page_size':30},{'dr_min':'nan'},{'fee':'bogus'},{'sort':'bogus'}):
            with self.assertRaises(ValueError): v2.paginate(rows, query)

    def test_legacy_submission_facts_count_once_without_claiming_link_is_live(self):
        for status in ('submitted', 'public', 'alive', 'live', 'removed', 'ALIVE', 'REMOVED'):
            for origin in ('ledger', 'history'):
                with self.subTest(status=status, origin=origin):
                    record = s.new_source('legacy.example')
                    receipt = dict(source_domain=record['domain'], site='ProbeKits', status=status,
                                   submitted_at='2026-10-20')
                    rows = [receipt] if origin == 'ledger' else []
                    if origin == 'history':
                        record['history'].append(receipt)
                    self.assertTrue(s.submitted(record, 'probekits', rows))
                    stats = v2.submissions(record, rows + rows, 'probekits')
                    self.assertEqual(stats['submission_status'], 'submitted')
                    self.assertEqual(stats['submit_count'], 1)
                    self.assertEqual(stats['submitted_products'], [dict(site='probekits', date='2026-10-20')])
                    self.assertEqual(stats['last_submitted_at'], '2026-10-20')
                    self.assertEqual(v2.submissions(record, rows, 'raumlens')['submission_status'], 'unsubmitted')

    def test_processing_and_failed_history_do_not_inflate_success_counts(self):
        for status in sorted(s.EXCLUDED | v2.PROCESSING | {'failed', 'abandoned', 'cancelled'}):
            if status in ('submitted', 'public', 'alive', 'live', 'removed'):
                continue
            for attempted in (False, True):
                with self.subTest(status=status, attempted=attempted):
                    record = s.new_source('boundary.example')
                    record['history'] = [dict(site='probekits', status=status)]
                    if attempted:
                        record['history'][0]['attempted_at'] = '2026-10-20'
                    stats = v2.submissions(record, [], 'probekits')
                    expected = 'processing' if status in v2.PROCESSING else 'unsubmitted'
                    self.assertEqual(stats['submission_status'], expected)
                    self.assertEqual(stats['submit_count'], 0)
                    self.assertEqual(stats['submitted_products'], [])


class LibraryV2StorageTests(TestCase):
    def setUp(self):
        self.conf = fixture_config()
        self.store = s.SourceStore(self.conf['sources_dir'])
        self.batch = BatchStore(self.conf)

    def source(self, name, **extra):
        data = dict(status='可投',submit_url='https://'+name+'/submit',scenario='directory',cost='free',dr='25',
                    dr_date=str(c.today()),fit_sites='probekits',backlink_required=False)
        data.update(extra)
        return self.store.update(name, 'screen', data, s.evidence('synthetic:v2',by='manual'))

    def receipt(self, name, status, origin):
        row = dict(source_domain=name, site='probekits', status=status, submitted_at='2026-10-20')
        if origin == 'ledger':
            fields, rows = c.read_csv(self.conf['ledger'])
            c.write_csv(self.conf['ledger'], s.unique(fields + list(row)), rows + [row])
        else:
            record = self.store.load(name)
            record['history'].append(row)
            c.atomic_json(self.store.root / (name + '.json'), record)

    def test_legacy_receipts_block_batch_preview_and_start_for_both_history_sources(self):
        for origin in ('ledger', 'history'):
            for status in ('submitted', 'public', 'alive', 'live', 'removed', 'ALIVE', 'REMOVED'):
                with self.subTest(origin=origin, status=status):
                    name = origin + '-' + status.lower() + '.example'
                    self.source(name)
                    self.receipt(name, status, origin)
                    data = dict(site='probekits', domains=[name])
                    preview = self.batch.preview(data)
                    self.assertEqual(preview['eligible'], [])
                    self.assertEqual(preview['skipped'], [dict(domain=name, reason='该产品已提交或处理中')])
                    with self.assertRaisesRegex(ValueError, 'no_eligible_platforms'):
                        self.batch.start(data)
                    self.assertEqual(self.batch.rows(), [])
                    row = library.listing(self.conf, dict(site='probekits', domain=name))['items'][0]
                    self.assertEqual((row['submission_status'], row['submit_count']), ('submitted', 1))

    def test_paged_listing_and_product_status(self):
        for i in range(55): self.source('p'+str(i)+'.example')
        self.assertEqual(len(library.listing(self.conf, {})['items']),50)
        self.assertEqual(library.listing(self.conf, {'page':2})['total'],55)
        v2.bulk(self.conf, dict(domains=['p0.example'],site='probekits',action='mark'))
        result = library.listing(self.conf, dict(site='probekits',submission_status='submitted'))
        self.assertEqual(result['total'],1)
        self.assertEqual(result['items'][0]['submit_count'],1)

    def test_batch_email_preflight_uses_product_or_shared_identity_without_copying(self):
        cases = [
            (None, {'value': 'shared@example.test'}, True),
            ({'value': ''}, {'variants': {'19': 'shared@example.test'}}, True),
            ({'value': 'product@example.test'}, None, True),
            ({'value': 'product@example.test'}, {'value': ''}, True),
            (None, None, False),
            ({'value': ''}, {'value': ''}, False),
        ]
        for index, (product_email, shared_email, eligible) in enumerate(cases):
            with self.subTest(product_email=product_email, shared_email=shared_email):
                name = 'email-' + str(index) + '.example'
                self.source(name)
                kit, _ = kits.load(self.conf, 'probekits')
                kit['fields'].pop('email', None)
                if product_email is not None:
                    kit['fields']['email'] = product_email
                path = kits.save(self.conf, 'probekits', kit)
                kits.save_profile(self.conf, dict(fields={} if shared_email is None else {'email': shared_email}))
                profile_path = kits.profile_path(self.conf)
                before = (path.read_bytes(), profile_path.read_bytes())
                loaded, directory = kits.load(self.conf, 'probekits')
                profile = kits.profile(self.conf)
                self.assertEqual(kits.check(loaded, directory, profile)[0], [])
                self.assertEqual(bool(c.kit_text(loaded, 'email') or c.kit_text(profile, 'email')), eligible)
                data = dict(site='probekits', domains=[name])
                preview = self.batch.preview(data)
                self.assertEqual([row['domain'] for row in preview['eligible']], [name] if eligible else [])
                if eligible:
                    self.assertEqual(preview['skipped'], [])
                    batch = self.batch.start(data)
                    self.assertEqual([job['domain'] for job in batch['jobs']], [name])
                    job = self.batch.claim({'owner': 'a' * 32})[0]
                    self.assertTrue(self.batch.attempt(job)['authorized'])
                else:
                    self.assertEqual(preview['skipped'], [dict(domain=name, reason='产品资料缺必填项：email')])
                    with self.assertRaisesRegex(ValueError, 'no_eligible_platforms'):
                        self.batch.start(data)
                self.assertEqual((path.read_bytes(), profile_path.read_bytes()), before)

    def test_attempt_rechecks_receipts_added_after_claim_without_marking_attempt(self):
        for origin in ('ledger', 'history'):
            for status in ('submitted', 'public', 'alive', 'live', 'removed', 'unknown', 'pending'):
                with self.subTest(origin=origin, status=status):
                    name = 'late-' + origin + '-' + status + '.example'
                    self.source(name)
                    self.batch.start(dict(site='probekits', domains=[name]))
                    job = self.batch.claim({'owner': 'a' * 32})[0]
                    self.receipt(name, status, origin)
                    before = self.batch.path(job['batch_id']).read_bytes()
                    with self.assertRaisesRegex(ValueError, 'submission_not_authorized_or_already_attempted'):
                        self.batch.attempt(job)
                    self.assertEqual(self.batch.path(job['batch_id']).read_bytes(), before)

    def test_attempt_allows_own_running_history_and_confirmed_failed_receipts(self):
        for origin in ('ledger', 'history'):
            name = 'retry-' + origin + '.example'
            self.source(name)
            self.receipt(name, 'failed', origin)
            self.batch.start(dict(site='probekits', domains=[name]))
            job = self.batch.claim({'owner': 'a' * 32})[0]
            self.assertTrue(self.batch.attempt(job)['authorized'])
            with self.assertRaisesRegex(ValueError, 'already_attempted'):
                self.batch.attempt(job)

    def test_migration_copies_all_legacy_submission_facts_from_ledger(self):
        name = 'legacy-migration.example'
        self.source(name)
        for status in ('submitted', 'public', 'alive', 'live', 'removed', 'ALIVE', 'REMOVED'):
            self.receipt(name, status, 'ledger')
        before = Path(self.conf['ledger']).read_bytes()
        report = v2.migration(self.conf, apply=True)
        saved = self.store.load(name)
        self.assertEqual(len(saved['history']), 7)
        self.assertEqual((report['submitted_platforms'], report['submitted_products']), (1, 1))
        self.assertEqual(saved['submission_summary']['submit_count'], 1)
        self.assertEqual(Path(self.conf['ledger']).read_bytes(), before)

    def test_migration_script_dry_run_and_apply_preserve_history(self):
        self.source('migration.example', scenario='outreach', cost='Regular free; Featured 9.99 USD optional')
        ledger = [dict(record_id='synthetic-receipt', source_domain='migration.example',
                       site='probekits', status='submitted', submitted_at='2026-10-20')]
        c.write_csv(self.conf['ledger'], list(ledger[0]), ledger)
        root = Path(self.conf['sources_dir']).parent
        config, report = root / 'migration-config.json', root / 'migration-report.json'
        c.atomic_json(config, self.conf)
        script = Path(__file__).resolve().parents[1] / 'scripts/migrate-library-v2.py'
        path = self.store.root / 'migration.example.json'
        before = path.read_bytes()
        ledger_before = Path(self.conf['ledger']).read_bytes()

        def run(mode):
            result = subprocess.run([sys.executable, str(script), '--config', str(config), mode,
                                     '--report', str(report)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout), json.loads(report.read_text()))
            return json.loads(result.stdout)

        preview = run('--dry-run')
        self.assertEqual(preview['total'], 1)
        self.assertEqual(preview['after_type'], {'other': 1})
        self.assertEqual(preview['after_fee'], {'freemium': 1})
        self.assertEqual(preview['submitted_products'], 1)
        self.assertEqual(path.read_bytes(), before)
        run('--apply')
        saved = self.store.load('migration.example')
        self.assertEqual(s.basic(saved, 'scenario'), 'other')
        self.assertEqual(saved['gates']['fee']['value'], 'freemium')
        self.assertEqual(saved['submission_summary']['submit_count'], 1)
        self.assertEqual(Path(self.conf['ledger']).read_bytes(), ledger_before)
        self.assertEqual(run('--dry-run')['before_fee'], {'freemium': 1})

    def test_import_preview_supplement_only_and_roundtrip(self):
        self.source('exists.example')
        text = 'url,type,fee,note\nhttps://exists.example/another,launch,paid,new note\nhttps://new.example/add,目录,免费,合成备注\nhttps://new.example/again,,,\nhttp://127.0.0.1/add,,,\nhttps://private.example/?token=SECRET,,,\nhttp://[bad,,,\n'
        data = dict(format='csv',text=text)
        before = {p.name:p.read_bytes() for p in self.store.root.glob('*') if p.is_file()}
        preview = v2.import_file(self.conf,data)
        self.assertEqual((preview['added'],preview['updated'],len(preview['skipped'])),(1,1,4))
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.store.root.glob('*') if p.is_file()})
        with patch.object(v2, 'refresh_dr', return_value={'found':0}):
            v2.import_file(self.conf,data,True)
        record = self.store.load('exists.example')
        self.assertEqual(s.basic(record,'scenario'),'directory')
        self.assertEqual(record['gates']['fee']['value'],'free')
        self.assertEqual(record['submit_urls'],['https://exists.example/submit','https://exists.example/another'])
        exported = v2.csv_text(v2.export_rows(self.conf,dict(domains=['new.example'])))
        self.assertTrue(exported.startswith('\ufeffurl,domain,type,fee'))
        self.assertEqual(v2.import_file(self.conf,dict(format='csv',text=exported))['added'],0)

    def test_export_formula_notes_are_inert_and_roundtrip_without_data_loss(self):
        import csv
        import io
        for note in ['=1+1', ' +SUM(1)', '-2+3', '@SUM(1)', '\t=1+1', "'literal", "'=literal"]:
            text = v2.csv_text([dict(url='https://formula.example/add', note=note)])
            exported = next(csv.DictReader(io.StringIO(text.lstrip('\ufeff'))))
            self.assertTrue(exported['note'].startswith("'"), repr(exported['note']))
            with patch.object(v2, 'refresh_dr', return_value={'found': 0}):
                v2.import_file(self.conf, dict(format='csv', text=text), True)
            self.assertEqual(s.basic(self.store.load('formula.example'), 'library_note'), note)
            (self.store.root / 'formula.example.json').unlink()

    def test_delete_keeps_ledger_and_manual_mark_can_be_revoked(self):
        self.source('delete.example')
        payload=dict(domains=['delete.example'],site='probekits',action='mark')
        v2.bulk(self.conf,payload)
        with self.assertRaises(ValueError):v2.bulk(self.conf,dict(domains=payload['domains'],action='delete'))
        before=Path(self.conf['ledger']).read_bytes()
        v2.bulk(self.conf,dict(domains=payload['domains'],action='delete',confirmation='DELETE 1'))
        self.assertFalse((self.store.root/'delete.example.json').exists())
        self.assertEqual(before,Path(self.conf['ledger']).read_bytes())
        self.source('delete.example')
        row=library.listing(self.conf,dict(site='probekits'))['items'][0]
        self.assertEqual(row['submission_status'],'submitted')
        v2.bulk(self.conf,dict(payload,action='unmark'))
        self.assertEqual(library.listing(self.conf,dict(site='probekits'))['items'][0]['submission_status'],'unsubmitted')

    def test_dr_cache_and_fake_script_stop_codes(self):
        self.source('cache.example',dr_date='2020-01-01')
        cache=Path(self.conf['ledger']).parent/'dr-cache.csv'
        c.write_csv(cache,['domain','dr','checked_date'],[dict(domain='cache.example',dr='42',checked_date=str(c.today()))])
        with patch.object(c,'enrich_dr',wraps=c.enrich_dr):
            result=v2.refresh_dr(self.conf,['cache.example'])
        self.assertEqual(result['found'],1)
        self.assertEqual(s.basic(self.store.load('cache.example'),'dr'),'42')
        self.source('fake.example',dr_date='2020-01-01')
        script=Path(self.conf['ledger']).parent/'fake-ahrefs.py'
        script.write_text("import json,sys\ndef load_key(): return 'SYNTHETIC_ONLY'\ndef run(args,key):\n print('code=quota',file=sys.stderr)\n return 1\n")
        self.conf['ahrefs_script']=str(script)
        with self.assertRaisesRegex(ValueError,'quota'):v2.refresh_dr(self.conf,['fake.example'])
        self.assertEqual(s.basic(self.store.load('fake.example'),'dr_date'),'2020-01-01')

    def test_queue_lock_checkpoint_manual_archive_and_receipt(self):
        for i in range(20):self.source('batch'+str(i)+'.example')
        data=dict(domains=['batch'+str(i)+'.example' for i in range(20)],site='probekits')
        with ThreadPoolExecutor(2) as pool:
            def start(_):
                try:return self.batch.start(data)
                except ValueError:return None
            replies=list(pool.map(start,range(2)))
        self.assertEqual(sum(r is not None for r in replies),1)
        ident=next(r['id'] for r in replies if r)
        jobs=self.batch.claim({'owner':'a'*32})
        self.assertEqual(len(jobs),10)
        self.assertEqual(self.batch.claim({'owner':'b'*32}),[])
        self.assertEqual(BatchStore(self.conf).status(ident)['counts']['running'],10)
        self.batch.attempt(jobs[0])
        with self.assertRaises(ValueError):self.batch.attempt(jobs[0])
        self.batch.result(dict(jobs[0],result='success',reason='thank you'))
        self.batch.result(dict(jobs[0],result='success',reason='repeated receipt'))
        self.assertEqual(len(c.read_csv(self.conf['ledger'])[1]),1)
        frame=dict(url=jobs[1]['url'],steps=[dict(fields=[dict(label='Product name',value='SYNTHETIC'),dict(label='Password',inputType='password',value='NEVER_SAVE'),dict(label='Captcha',value='NEVER_SAVE')])])
        saved=self.batch.result(dict(jobs[1],result='manual',reason='验证码',frames=[frame]))
        self.assertTrue(saved['archive_saved'])
        handoff=Path(self.conf['handoff_dir'])/(jobs[1]['id']+'.json')
        self.assertNotIn('NEVER_SAVE',handoff.read_text())
        for job in jobs[2:]:self.batch.result(dict(job,result='failed',reason='表单报错'))
        second=self.batch.claim({'owner':'b'*32})
        self.assertEqual(len(second),10)
        self.batch.control(dict(id=ident,action='pause'))
        with self.assertRaises(ValueError):self.batch.attempt(second[0])
        with patch('backlink_kit.batch.time.time',return_value=time.time()+181):self.batch.claim({'owner':'b'*32})
        self.assertEqual(self.batch.status(ident)['counts']['unknown'],10)
        path=Path(self.conf['runs_dir'])/str(c.today())/('batch-'+ident+'.csv')
        self.assertTrue(path.read_bytes().startswith(b'\xef\xbb\xbf'))
        self.batch.result(dict(batch_id=ident,id=jobs[1]['id'],result='abandoned'),manual=True)
        self.assertNotIn('archive',json.loads(handoff.read_text()))

    def test_stop_releases_unstarted_jobs(self):
        for i in range(12):self.source('stop'+str(i)+'.example')
        batch=self.batch.start(dict(site='probekits',domains=['stop'+str(i)+'.example' for i in range(12)]))
        self.batch.claim({'owner':'a'*32})
        stopped=self.batch.control(dict(id=batch['id'],action='stop'))
        self.assertEqual(stopped['counts']['cancelled'],2)
        self.assertEqual(self.batch.claim({'owner':'b'*32}),[])

    def test_expired_lease_cannot_authorize_before_next_claim(self):
        self.source('expired.example')
        self.batch.start(dict(site='probekits', domains=['expired.example']))
        job = self.batch.claim({'owner': 'a' * 32})[0]
        with patch('backlink_kit.batch.time.time', return_value=job['started'] + 181):
            with self.assertRaisesRegex(ValueError, 'expired'):
                self.batch.attempt(job)
        saved = self.batch.status(job['batch_id'])['jobs'][0]
        self.assertEqual(saved['state'], 'unknown')
        self.assertNotIn('attempted_at', saved)

    def test_manual_snapshot_reopens_top_level_checkpoint_not_original_entry(self):
        self.source('steps.example')
        self.batch.start(dict(site='probekits', domains=['steps.example']))
        job = self.batch.claim({'owner': 'a' * 32})[0]
        checkpoint = 'https://steps.example/step2#bk=' + job['id']
        frames = [dict(frame_id=0, url=checkpoint, steps=[dict(fields=[dict(label='Product name', value='Checkpoint')])])]
        result = self.batch.result(dict(job, result='manual', reason='验证码', frames=frames))
        self.assertTrue(result['archive_saved'])
        saved = json.loads((Path(self.conf['handoff_dir']) / (job['id'] + '.json')).read_text())
        self.assertEqual(saved['submit_url'], checkpoint)
        self.assertEqual(saved['archive']['frames'][0]['url'], checkpoint)
        self.assertEqual(saved['archive']['frames'][0]['frame_id'], 0)

    def test_abandon_after_unknown_keeps_attempt_lock_but_unattempted_manual_releases(self):
        for name in ['unknown.example', 'manual.example']:
            self.source(name)
        self.batch.start(dict(site='probekits', domains=['unknown.example', 'manual.example']))
        jobs = {j['domain']: j for j in self.batch.claim({'owner': 'a' * 32})}
        attempted = jobs['unknown.example']
        self.batch.attempt(attempted)
        self.batch.result(dict(attempted, result='unknown', reason='无反馈'))
        manual = jobs['manual.example']
        self.batch.result(dict(manual, result='manual', reason='缺资料'))
        for job in [attempted, manual]:
            self.batch.result(dict(job, result='abandoned'), manual=True)
        preview = self.batch.preview(dict(site='probekits', domains=['unknown.example', 'manual.example']))
        self.assertEqual([r['domain'] for r in preview['eligible']], ['manual.example'])
        self.assertEqual(preview['skipped'][0]['domain'], 'unknown.example')
        row = next(r for r in library.listing(self.conf, {'site': 'probekits'})['items'] if r['domain'] == 'unknown.example')
        self.assertEqual(row['submission_status'], 'processing')

    def test_manual_submission_event_persists_unknown_before_abandon(self):
        from backlink_kit.extension_api import ExtensionAPI
        from backlink_kit.handoff import Store
        self.source('human.example')
        self.batch.start(dict(site='probekits', domains=['human.example']))
        job = self.batch.claim({'owner': 'a' * 32})[0]
        self.batch.result(dict(job, result='manual', reason='验证码'))
        api = ExtensionAPI(self.conf, Store(self.conf['handoff_dir'], self.conf))
        reply = api.post('submission-attempt', {'id': job['id']})
        self.assertEqual(reply['status'], '结果未知')
        saved = self.batch.load(job['batch_id'])['jobs'][0]
        self.assertTrue(saved['attempted_at'])
        self.batch.result(dict(job, result='abandoned'), manual=True)
        preview = self.batch.preview(dict(site='probekits', domains=['human.example']))
        self.assertEqual(preview['eligible'], [])
