"""外链库只访问隔离资料；HTTP 请求仅发往本机带令牌服务。"""
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

from backlink_kit import core as c, sources as s, handoff as h
from tests import test_extension_api as api_tests


class LibraryAPITests(unittest.TestCase):
    conf: dict
    setUp = api_tests.ApiTests.setUp
    call = api_tests.ApiTests.call

    def test_skipping_an_attempt_does_not_remove_the_persistent_submission_lock(self):
        self.source()
        payload = {'domain': 'x.example', 'site': 'probekits'}
        prepared = self.call('library_prepare', data=payload)[1]
        self.assertEqual(self.call('submission-attempt', data={'id': prepared['id']})[0], 200)
        self.assertEqual(self.call('skip', data={'id': prepared['id'], 'reason': '不再处理，但结果仍未知'})[0], 200)
        row = self.call('library', 'site=probekits')[1]['items'][0]
        self.assertEqual(row['reuse_state'], 'already_submitted')
        self.assertEqual(self.call('library_prepare', data=payload)[0], 409)
        self.assertEqual(len(h.Store(self.conf['handoff_dir'], self.conf).rows()), 1)
        context = self.call('source', 'site=probekits&url=https://x.example/submit')[1]
        self.assertTrue(context['submission_locked'])
        history = s.SourceStore(self.conf['sources_dir']).load('x.example')['history']
        self.assertTrue(any(item.get('attempted_at') for item in history))

    def test_sensitive_entry_urls_are_not_returned_or_reused_but_original_evidence_survives(self):
        for suffix in ('?token=SYNTHETIC_SECRET', '?email=private%40example.test',
                       '?next=https%3A%2F%2Fx.example%2F%3Faccess_token%3DSYNTHETIC_SECRET',
                       '#access_token=SYNTHETIC_SECRET'):
            self.source(submit_url='https://x.example/submit' + suffix)
            before = s.SourceStore(self.conf['sources_dir']).load('x.example')
            row = self.call('library', 'site=probekits')[1]['items'][0]
            self.assertNotIn('SYNTHETIC_SECRET', json.dumps(row))
            self.assertNotIn('private%40', json.dumps(row))
            self.assertEqual(row['submit_url'], '')
            self.assertEqual(row['reuse_state'], 'needs_review')
            self.assertEqual(self.call('library_prepare', data={'domain': 'x.example', 'site': 'probekits'})[0], 409)
            self.assertEqual(before, s.SourceStore(self.conf['sources_dir']).load('x.example'))

    def test_prepare_validates_target_before_any_write(self):
        from backlink_kit import library
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        for payload in (None, [], {}, {'domain': 'x.example'}, {'domain': 'x.example', 'site': []},
                        {'domain': '../escape', 'site': 'probekits'}, {'domain': 'x.example', 'site': 'other'},
                        {'domain': 'x.example', 'site': 'probekits', 'plan': {'items': []}}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                library.prepare(self.conf, payload)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_empty_recipe_and_active_url_drift_cannot_create_another_task(self):
        store = s.SourceStore(self.conf['sources_dir'])
        record = self.source('empty-recipe.example')
        record['recipe']['steps'] = []
        c.atomic_json(store.root / 'empty-recipe.example.json', record)
        status, error = self.call('library_prepare', data={'domain': 'empty-recipe.example', 'site': 'probekits'})
        self.assertEqual(status, 409)
        self.assertIn('library_not_ready', error['error'])
        self.assertEqual(self.call('library', 'site=probekits')[1]['items'][0]['reuse_state'], 'needs_review')
        self.source()
        payload = {'domain': 'x.example', 'site': 'probekits'}
        status, prepared = self.call('library_prepare', data=payload)
        self.assertEqual(status, 200)
        record = store.load('x.example')
        record['submit_urls'] = ['https://x.example/different-form']
        c.atomic_json(store.root / 'x.example.json', record)
        self.assertEqual(self.call('library_prepare', data=payload)[0], 409)
        self.assertEqual(len(h.Store(self.conf['handoff_dir'], self.conf).rows()), 1)

    def test_unknown_history_wins_over_existing_active_item_and_expiry_requires_review(self):
        self.source()
        payload = {'domain': 'x.example', 'site': 'probekits'}
        status, prepared = self.call('library_prepare', data=payload)
        self.assertEqual(status, 200)
        tasks = h.Store(self.conf['handoff_dir'], self.conf)
        row = tasks.load(prepared['id'])
        row['created_at'] = '2020-01-01'
        tasks.save(row)
        self.assertEqual(self.call('library_prepare', data=payload)[0], 409)
        row['created_at'] = h.stamp()
        tasks.save(row)
        s.SourceStore(self.conf['sources_dir']).update('x.example', 'history',
            {'site': 'probekits', 'status': 'unknown', 'record_id': 'old-attempt'}, s.evidence('synthetic:unknown'))
        self.assertEqual(self.call('library_prepare', data=payload)[0], 409)
        self.assertEqual(len(tasks.rows()), 1)

    def test_prepare_rechecks_qualification_and_rejects_every_unknown_or_submitted_origin(self):
        tasks = h.Store(self.conf['handoff_dir'], self.conf)
        store = s.SourceStore(self.conf['sources_dir'])
        for name, changes in [('unverified', {'status': '待核实'}), ('unfit', {'fit_sites': 'raumlens'}),
                              ('paid', {'cost': 'paid'}), ('automation', {'automation_forbidden': True}),
                              ('license', {'license_risk': True}), ('stale', {'dr_date': '2020-01-01'})]:
            self.source(name + '.example', **changes)
            with self.subTest(name=name):
                self.assertEqual(self.call('library_prepare', data={'domain': name + '.example', 'site': 'probekits'})[0], 409)
        self.assertEqual(tasks.rows(), [])
        for origin in ('history', 'ledger', 'handoff'):
            for index, status in enumerate(('unknown', '结果未知', '待核实', 'submitted', 'public', '续填中')):
                name = origin + '-' + str(index) + '.example'
                self.source(name)
                row = {'source_domain': name, 'site': 'probekits', 'status': status}
                if origin == 'history':
                    store.update(name, 'history', row, s.evidence('synthetic:history'))
                elif origin == 'ledger':
                    c.write_csv(self.conf['ledger'], ['source_domain', 'site', 'status'], [row])
                else:
                    saved = h.save_progress(tasks.root, name, 'probekits', 'https://' + name + '/submit', {'items': []})
                    saved['status'] = status
                    tasks.save(saved)
                before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
                with self.subTest(origin=origin, status=status):
                    self.assertEqual(self.call('library_prepare', data={'domain': name, 'site': 'probekits'})[0], 409)
                    self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_prepare_reuses_active_history_but_submission_attempt_permanently_blocks_it(self):
        self.source()
        payload = {'domain': 'x.example', 'site': 'probekits'}
        status, prepared = self.call('library_prepare', data=payload)
        self.assertEqual(status, 200)
        tasks = h.Store(self.conf['handoff_dir'], self.conf)
        saved = tasks.load(prepared['id'])
        s.SourceStore(self.conf['sources_dir']).update('x.example', 'history', saved, s.evidence('synthetic:task'))
        self.assertEqual(self.call('library_prepare', data=payload), (200, prepared))
        self.assertEqual(self.call('submission-attempt', data={'id': prepared['id']})[0], 200)
        self.assertEqual(tasks.load(prepared['id'])['status'], '结果未知')
        self.assertEqual(self.call('library_prepare', data=payload)[0], 409)
        self.assertEqual(self.call('library', 'site=probekits')[1]['items'][0]['reuse_state'], 'already_submitted')
        self.assertEqual(len(tasks.rows()), 1)

    def test_prepare_persists_current_product_plan_and_is_idempotent(self):
        self.source(fit_sites='probekits|raumlens')
        store = s.SourceStore(self.conf['sources_dir'])
        store.update('x.example', 'memory', [{'label': 'Product name', 'key': 'name', 'value': 'OLD PRODUCT COPY'}],
                     s.evidence('manual', by='manual'), 'probekits')
        product = json.loads((Path(self.conf['kits_dir']) / 'probekits/kit.json').read_text())
        product['site'] = 'raumlens'
        product['fields']['name'] = {'value': 'Selected new product', 'variants': {}}
        c.atomic_json(Path(self.conf['kits_dir']) / 'raumlens/kit.json', product)
        before = store.load('x.example')
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(lambda _: self.call('library_prepare', data={'domain': 'x.example',
                                                                                'site': 'raumlens'}), range(4)))
        self.assertTrue(all(code == 200 for code, _ in replies), replies)
        result = replies[0][1]
        self.assertEqual(set(result), {'id', 'site', 'submit_url'})
        self.assertEqual(result['site'], 'raumlens')
        self.assertEqual(result['submit_url'], 'https://x.example/submit')
        self.assertEqual({r['id'] for _, r in replies}, {result['id']})
        saved = h.Store(self.conf['handoff_dir'], self.conf).load(result['id'])
        self.assertEqual(saved['status'], '待处理')
        self.assertEqual(saved['fields'][0]['value'], 'Selected new product')
        self.assertNotIn('OLD PRODUCT COPY', json.dumps(saved))
        self.assertEqual(len(h.Store(self.conf['handoff_dir'], self.conf).rows()), 1)
        self.assertEqual(store.load('x.example'), before)
        # 从已有 agentOpen 的 item 接口读回，证明不是短期扩展存储里的孤立 ID。
        status, context = self.call('item', 'id=' + result['id'])
        self.assertEqual(status, 200)
        self.assertEqual(context['site'], 'raumlens')
        self.assertEqual(context['fields'][0]['value'], 'Selected new product')

    def test_imported_unsafe_or_missing_urls_never_become_ready_and_dates_are_not_invented(self):
        store = s.SourceStore(self.conf['sources_dir'])
        for name, urls in [('unsafe.example', ['javascript:alert(1)']), ('missing-url.example', [])]:
            record = self.source(name)
            record['submit_urls'] = urls
            c.atomic_json(store.root / (name + '.json'), record)
        record = s.new_source('old.example')
        proof = s.evidence('/private/old.json', checked_at='2020-01-02', by='manual')
        s.apply_event(record, 'screen', {'status': '待核实'}, proof)
        c.atomic_json(store.root / 'old.example.json', record)
        c.atomic_json(store.root / 'empty.example.json', s.new_source('empty.example'))
        status, result = self.call('library', 'site=probekits')
        self.assertEqual(status, 200)
        items = {r['domain']: r for r in result['items']}
        for name in ('unsafe.example', 'missing-url.example'):
            self.assertEqual(items[name]['reuse_state'], 'needs_review')
            self.assertEqual(items[name]['submit_url'], '')
        self.assertEqual(items['old.example']['last_checked_at'], '2020-01-02')
        self.assertEqual(items['empty.example']['last_checked_at'], '')
        self.assertEqual(store.load('unsafe.example')['submit_urls'], ['javascript:alert(1)'])

    def test_filters_and_counts_describe_exactly_returned_items(self):
        self.source('ready.example')
        self.source('review.example', fit_sites='raumlens')
        self.source('submitted.example', scenario='launch')
        self.source('blocked.example', status='不做')
        store = s.SourceStore(self.conf['sources_dir'])
        store.update('submitted.example', 'history', {'site': 'probekits', 'status': 'submitted'}, s.evidence('test'))
        self.call('library', data={'domain': 'review.example', 'submit_url': 'https://tally.so/r/find-me'})
        cases = [('', {'ready', 'review', 'submitted', 'blocked'}),
                 ('status=confirmed', {'ready', 'review', 'submitted'}), ('status=ready', {'ready'}),
                 ('status=needs_review', {'review'}), ('status=already_submitted', {'submitted'}),
                 ('status=blocked', {'blocked'}), ('status=unknown', set()),
                 ('scenario=launch', {'submitted'}), ('q=READY', {'ready'}),
                 ('q=find-me', {'review'}), ('status=confirmed&scenario=directory&q=review', {'review'}),
                 ('status=ready&scenario=launch', set())]
        for query, expected in cases:
            with self.subTest(query=query):
                status, result = self.call('library', 'site=probekits&' + query)
                self.assertEqual(status, 200)
                self.assertEqual({r['domain'].removesuffix('.example') for r in result['items']}, expected)
                self.assertEqual(result['counts']['total'], len(expected))
                self.assertEqual(result['counts']['confirmed'], len(expected - {'blocked'}))
                for state, name in [('ready', 'ready'), ('needs_review', 'review'),
                                    ('already_submitted', 'submitted'), ('blocked', 'blocked')]:
                    self.assertEqual(result['counts'][state], int(name in expected))
        self.assertEqual(self.call('library', 'status=bogus')[0], 409)
        self.assertEqual(self.call('library', 'scenario=bogus')[0], 409)

    def test_history_summaries_hide_product_text_and_block_unknown_without_mutation(self):
        store = s.SourceStore(self.conf['sources_dir'])
        for name in ('history.example', 'ledger.example', 'handoff.example', 'other.example', 'queued.example'):
            self.source(name)
        store.update('history.example', 'memory', [{'label': 'Description', 'value': 'PRIVATE PRODUCT COPY'}],
                     s.evidence('/private/path', 'PRIVATE EVIDENCE', by='manual'), 'raumlens')
        store.update('history.example', 'history', {'record_id': 'one', 'site': 'ProbeKits', 'status': 'unknown',
                     'submitted_at': '2026-10-01', 'receipt': 'SECRET PASSWORD',
                     'source_url': 'https://' + 'user:SECRET' + '@history.example/', 'raw_href': '/private/local'},
                     s.evidence('/private/ledger.csv'))
        store.update('other.example', 'history', {'site': 'raumlens', 'status': 'public',
                     'first_public_at': '2026-10-02', 'source_url': 'https://other.example/listing',
                     'raw_href': 'https://raumlens.com/'}, s.evidence('/private/history'))
        c.write_csv(self.conf['ledger'], ['record_id', 'source_domain', 'site', 'status'],
                    [{'record_id': 'two', 'source_domain': 'ledger.example', 'site': 'probekits', 'status': 'pending'}])
        c.atomic_json(Path(self.conf['handoff_dir']) / 'unknown.json',
                      {'id': 'unknown', 'source_domain': 'handoff.example', 'site': 'probekits',
                       'status': '结果未知', 'fields': [{'value': 'PRIVATE HANDOFF'}]})
        c.atomic_json(Path(self.conf['handoff_dir']) / 'queued.json',
                      {'id': 'queued', 'source_domain': 'queued.example', 'site': 'probekits', 'status': '待人工'})
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(c, 'fetch', side_effect=AssertionError('外链库不得访问网站')):
            status, result = self.call('library', 'site=probekits')
        self.assertEqual(status, 200)
        by_domain = {r['domain']: r for r in result['items']}
        for name in ('history', 'ledger', 'handoff'):
            self.assertEqual(by_domain[name + '.example']['reuse_state'], 'already_submitted')
        self.assertEqual(by_domain['queued.example']['reuse_state'], 'needs_review')
        self.assertEqual(by_domain['other.example']['reuse_state'], 'ready')
        self.assertEqual(by_domain['other.example']['previous_sites'], ['raumlens'])
        self.assertEqual(by_domain['other.example']['history'],
                         [{'site': 'raumlens', 'status': 'public', 'date': '2026-10-02',
                           'source_url': 'https://other.example/listing', 'raw_href': 'https://raumlens.com/'}])
        encoded = json.dumps(result)
        for secret in ('PRIVATE', 'SECRET', '/private/', 'memories', 'evidence', 'fields', 'receipt'):
            self.assertNotIn(secret, encoded)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_ready_reuses_campaign_gates_and_requires_selected_product(self):
        self.source('ready.example')
        self.source('other-product.example', fit_sites='raumlens')
        self.source('unverified.example', status='待核实')
        self.source('blocked.example', status='不做')
        self.source('low.example', dr='9')
        self.source('stale-dr.example', dr_date='2020-01-01')
        self.source('approval.example', scenario='community')
        self.source('paid.example', cost='paid')
        self.source('backlink.example', backlink_required=True)
        store = s.SourceStore(self.conf['sources_dir'])
        for name, change in (('missing.example', None), ('stale-recipe.example', 'old'),
                             ('changed.example', 'changed'), ('partial.example', 'partial'),
                             ('missing-field.example', 'field'), ('captcha.example', 'captcha')):
            r = self.source(name)
            if change is None:
                r['recipe'] = None
            elif change == 'old':
                r['recipe']['checked_at'] = '2020-01-01'
            elif change == 'changed':
                r['recipe']['state'] = '表单已变'
            elif change == 'partial':
                r['recipe']['complete'] = False
            elif change == 'field':
                r['recipe']['steps'][0]['fields'].append({'label': 'Unspecified detail', 'required': True,
                                                        'inputType': 'text', 'role': 'textbox'})
            elif change == 'captcha':
                r['recipe']['blockers'] = [{'kind': 'captcha', 'step': 0}]
            c.atomic_json(store.root / (name + '.json'), r)
        self.assertEqual(self.call('library')[1]['counts']['ready'], 0)
        status, result = self.call('library', 'site=probekits')
        self.assertEqual(status, 200)
        states = {r['domain']: r['reuse_state'] for r in result['items']}
        self.assertEqual({d for d, state in states.items() if state == 'ready'}, {'ready.example'})
        self.assertEqual(states['blocked.example'], 'blocked')
        self.assertEqual(states['paid.example'], 'blocked')
        self.assertEqual(states['backlink.example'], 'blocked')
        for name in ('other-product', 'unverified', 'low', 'stale-dr', 'approval', 'missing',
                     'stale-recipe', 'changed', 'partial', 'missing-field', 'captcha'):
            self.assertEqual(states[name + '.example'], 'needs_review', name)
        self.assertTrue(all(r['reasons'] for r in result['items'] if r['reuse_state'] != 'ready'))
        # 新产品没有准入配对，不能靠别的产品已投历史获得批准。
        store.update('other-product.example', 'history', {'site': 'raumlens', 'status': 'public'},
                     s.evidence('synthetic:history'))
        self.assertEqual(self.call('library', 'site=probekits&q=other-product')[1]['items'][0]['reuse_state'],
                         'needs_review')
        self.assertEqual(self.call('library', 'site=no-such-site')[0], 409)

    def test_reject_invalid_payloads_without_writing(self):
        bad = [None, [], 'platform', {}, {'domain': '../escape'}, {'domain': 'good.example/path'},
               {'domain': 'https://good.example'}, {'domain': 'a..example'}, {'domain': '-a.example'},
               {'domain': 'localhost'}, {'domain': '127.0.0.1'}, {'domain': 'good.example', 'dr': 'NaN'},
               {'domain': 'good.example', 'dr': True}, {'domain': 'good.example', 'dr': 101},
               {'domain': 'good.example', 'dr_date': 'yesterday'},
               {'domain': 'good.example', 'admission': 'approved'},
               {'domain': 'good.example', 'fee': 'maybe'}, {'domain': 'good.example', 'backlink': 'false'},
               {'domain': 'good.example', 'fit_sites': 'probekits'},
               {'domain': 'good.example', 'fit_sites': ['no-such-site']},
               {'domain': 'good.example', 'scenario': 'mystery'}, {'domain': 'good.example', 'note': {}},
               {'domain': 'good.example', 'memories': {'probekits': 'untrusted'}}]
        # None 作为 JSON body 由直接调用覆盖，避免 call() 把它当 GET。
        from backlink_kit import library
        with self.assertRaises(ValueError):
            library.save(self.conf, None)
        for payload in bad[1:]:
            with self.subTest(payload=payload):
                self.assertEqual(self.call('library', data=payload)[0], 409)
        for url in ('javascript:alert(1)', 'file:///private/data', '//good.example/submit',
                    'https://' + 'user:password' + '@good.example/', 'http://localhost:1234/',
                    'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/',
                    'https://intranet.local/', 'https://good.example\\@evil.example/',
                    'https://good.example/%0aheader', 'https://good.example:bad/'):
            with self.subTest(url=url):
                self.assertEqual(self.call('library', data={'domain': 'good.example', 'submit_url': url})[0], 409)
        self.assertEqual(s.SourceStore(self.conf['sources_dir']).rows(), [])

    def test_optional_values_and_equivalent_urls_are_deduplicated(self):
        payload = {'domain': 'WWW.NEW.EXAMPLE', 'submit_url': 'HTTPS://WWW.NEW.EXAMPLE/submit#form',
                   'admission': '', 'dr': None, 'scenario': '', 'fit_sites': [], 'fee': '',
                   'backlink': None, 'note': None}
        self.assertEqual(self.call('library', data=payload)[0], 200)
        payload['submit_url'] = 'https://www.new.example/submit'
        self.assertEqual(self.call('library', data=payload)[0], 200)
        record = s.SourceStore(self.conf['sources_dir']).load('new.example')
        self.assertEqual(record['submit_urls'], ['https://www.new.example/submit'])
        self.assertEqual(record['admission']['value'], '待核实')

    def source(self, name='x.example', **changes) -> dict:
        store = s.SourceStore(self.conf['sources_dir'])
        row = dict(status='可投', submit_url='https://' + name + '/submit', scenario='directory',
                   fit_sites='probekits', dr='25', dr_date=str(c.today()), cost='free',
                   backlink_required=False, license_risk=False, automation_forbidden=False)
        row.update(changes)
        store.update(name, 'screen', row, s.evidence('synthetic:screen', by='manual'))
        return store.update(name, 'capture', {'fields': [{'label': 'Product name', 'inputType': 'text',
                                                         'required': True}]}, s.evidence('synthetic:capture'))

    def test_manual_updates_preserve_complete_source_and_unknowns_do_not_erase(self):
        self.source()
        store = s.SourceStore(self.conf['sources_dir'])
        store.update('x.example', 'memory', [{'label': 'Description', 'value': 'OLD PRODUCT COPY'}],
                     s.evidence('/private/form.json', by='manual'), 'raumlens')
        before = store.update('x.example', 'history', {'site': 'raumlens', 'status': 'public',
                              'record_id': 'old', 'raw_href': 'https://raumlens.com/'},
                              s.evidence('/private/ledger.csv'))
        status, _ = self.call('library', data={'domain': 'www.x.example', 'note': 'Manual platform note',
                                              'dr': 'UNKNOWN', 'dr_date': '', 'fee': 'UNKNOWN',
                                              'backlink': 'UNKNOWN', 'fit_sites': None})
        self.assertEqual(status, 200)
        after = store.load('x.example')
        for key in ('admission', 'gates', 'recipe', 'recipe_versions', 'memories',
                    'history', 'blockers', 'submit_urls', 'form_hosts'):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(after['evidence'][-1]['quote'], 'Manual platform note')
        self.assertEqual({key: value for key, value in after['basic'].items() if key != 'library_note'}, before['basic'])
        self.assertEqual(s.basic(after, 'library_note'), 'Manual platform note')
        status, _ = self.call('library', data={'domain': 'x.example', 'admission': '可投',
                                              'submit_url': 'https://tally.so/r/abc', 'scenario': 'launch',
                                              'dr': 31, 'dr_date': '2026-10-01',
                                              'fit_sites': ['probekits', 'raumlens'],
                                              'fee': 'free', 'backlink': False})
        self.assertEqual(status, 200)
        after = store.load('x.example')
        self.assertEqual(s.basic(after, 'scenario'), 'launch')
        self.assertEqual(s.basic(after, 'fit_sites'), 'probekits|raumlens')
        self.assertEqual(s.basic(after, 'dr'), 31)
        self.assertEqual(s.basic(after, 'dr_date'), '2026-10-01')
        self.assertEqual(after['basic']['dr']['evidence'][-1]['path'], 'extension:library')
        self.assertEqual(after['basic']['dr_date']['checked_at'], str(c.today()))
        self.assertEqual(after['submit_urls'], ['https://tally.so/r/abc', 'https://x.example/submit'])
        for key in ('recipe', 'recipe_versions', 'memories', 'history', 'blockers'):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(len(list(store.root.glob('*.json'))), 1)

    def test_add_defaults_to_unverified_and_reads_persisted_source(self):
        status, saved = self.call('library', data={'domain': 'WWW.New.Example',
                                                  'submit_url': 'https://new.example/submit'})
        self.assertEqual(status, 200)
        self.assertEqual(saved['domain'], 'new.example')
        status, result = self.call('library')
        self.assertEqual(status, 200)
        self.assertEqual(result['site'], '')
        self.assertEqual(result['counts'], dict(total=1, confirmed=0, ready=0,
                                               needs_review=0, already_submitted=0, blocked=0))
        item = result['items'][0]
        self.assertEqual(set(item), {'domain', 'submit_url', 'scenario', 'admission', 'reuse_state',
                                    'reasons', 'dr', 'dr_date', 'fee', 'login', 'backlink',
                                    'has_recipe', 'previous_sites', 'history', 'last_checked_at', 'fit_sites', 'note'})
        self.assertEqual(item['admission'], '待核实')
        self.assertEqual(item['reuse_state'], 'unknown')
        self.assertEqual(item['fee'], 'UNKNOWN')
        record = s.SourceStore(self.conf['sources_dir']).load('new.example')
        self.assertEqual(record['admission']['by'], 'manual')
        self.assertEqual(record['admission']['evidence'][0]['path'], 'extension:library')
        self.assertEqual(c.read_csv(self.conf['directories'])[1], [])
        self.assertEqual(c.read_csv(self.conf['ledger'])[1], [])
        self.assertEqual(len(list(Path(self.conf['sources_dir']).glob('*.json'))), 1)


    def test_explicit_empty_fit_withdraws_current_qualification_without_erasing_evidence(self):
        before = self.source()
        status, _ = self.call('library', data={'domain': 'x.example', 'fit_sites': []})
        self.assertEqual(status, 200)
        row = self.call('library', 'site=probekits')[1]['items'][0]
        self.assertEqual(row['fit_sites'], [])
        self.assertEqual(row['reuse_state'], 'needs_review')
        saved = s.SourceStore(self.conf['sources_dir']).load('x.example')
        self.assertEqual(saved['recipe'], before['recipe'])
        for proof in before['basic']['fit_sites']['evidence']:
            self.assertIn(proof, saved['basic']['fit_sites']['evidence'])

    def test_fee_and_backlink_unknown_cannot_be_ready_by_admission_alone(self):
        store = s.SourceStore(self.conf['sources_dir'])
        for gate in ('fee', 'backlink'):
            record = self.source(gate + '.example')
            record['gates'].pop(gate)
            c.atomic_json(store.root / (gate + '.example.json'), record)
            row = self.call('library', 'site=probekits&q=' + gate + '.example')[1]['items'][0]
            self.assertEqual(row['reuse_state'], 'needs_review', gate)

if __name__ == '__main__':
    unittest.main()
