"""待验证存档通过真实本机 HTTP 接口验收，数据只写临时副本。"""
from copy import deepcopy
import unittest

from tests import test_extension_api as api_tests
from backlink_kit import handoff, sources


class ArchiveTests(unittest.TestCase):
    conf: dict
    setUp = api_tests.ApiTests.setUp
    call = api_tests.ApiTests.call

    def payload(self):
        return {'site': 'probekits', 'url': 'https://x.example/submit', 'frames': [
            {'url': 'https://x.example/submit', 'site': 'probekits', 'source_domain': 'x.example',
             'step_index': 0, 'complete': False, 'has_next': False, 'verification': True,
             'steps': [{'fields': [
                 {'label': 'Product name', 'key': 'name', 'inputType': 'text', 'value': 'Manual product name',
                  'locator': {'id': 'product', 'label': 'Product name', 'inputType': 'text'}},
                 {'label': 'Website URL', 'key': 'url', 'inputType': 'url', 'value': 'https://probekits.com/'},
                 {'label': 'CAPTCHA', 'key': 'captcha', 'inputType': 'text', 'value': 'SECRET-CODE'},
             ]}]}]}

    def test_archive_durable_idempotent_and_pins_exact_values(self):
        payload = self.payload()
        code, saved = self.call('archive', data=payload)
        self.assertEqual(code, 200, saved)
        self.assertTrue(saved['archive']['only_verification'])
        ident = saved['id']
        code, again = self.call('archive', data=payload)
        self.assertEqual(code, 200)
        self.assertEqual(again['id'], ident)
        store = handoff.Store(self.conf['handoff_dir'])
        record = store.load(ident)
        self.assertEqual(len(store.rows()), 1)
        self.assertNotIn('SECRET-CODE', str(record))
        self.assertEqual(record['archive']['frames'][0]['steps'][0]['fields'][0]['value'], 'Manual product name')
        record['created_at'] = '2020-01-01T00:00:00+08:00'
        store.save(record)
        code, queue = self.call('queue')
        self.assertEqual(len(queue), 1, queue)
        self.assertEqual(queue[0]['source_domain'], 'x.example')
        code, context = self.call('item', 'id=' + ident)
        self.assertEqual(code, 200)
        self.assertEqual(context['archive']['frames'][0]['steps'][0]['fields'][0]['value'], 'Manual product name')
        self.assertFalse(context['archive']['frames'][0]['complete'])
        self.assertTrue(sources.SourceStore(self.conf['sources_dir']).load('x.example')['memories'])

    def test_partial_files_multistep_and_required_sensitive_fields_never_claim_only_captcha(self):
        for field in [
            {'label': 'Logo', 'inputType': 'file', 'value': '', 'required': True},
            {'label': 'Description', 'inputType': 'text', 'value': '', 'required': True},
            {'label': 'Agree to terms', 'key': 'ownership', 'value': 'YES', 'required': True},
        ]:
            payload = self.payload()
            payload['frames'][0]['steps'][0]['fields'].append(field)
            code, saved = self.call('archive', data=payload)
            self.assertEqual(code, 200, saved)
            self.assertFalse(saved['archive']['only_verification'], field)
        payload = self.payload()
        payload['frames'][0]['has_next'] = True
        self.assertFalse(self.call('archive', data=payload)[1]['archive']['only_verification'])

    def test_archive_rejects_malformed_payloads_unknown_results_and_repeat_after_done(self):
        for mutate in [lambda p: p.update(frames='bad'), lambda p: p['frames'][0].update(steps=['bad']),
                       lambda p: p['frames'][0]['steps'][0].update(fields=['bad'])]:
            payload = self.payload()
            mutate(payload)
            self.assertEqual(self.call('archive', data=payload)[0], 409)
        code, saved = self.call('archive', data=self.payload())
        self.assertEqual(code, 200, saved)
        store = handoff.Store(self.conf['handoff_dir'])
        record = store.load(saved['id'])
        record['status'] = '待核实'
        store.save(record)
        self.assertEqual(self.call('archive', data=self.payload())[0], 409)

    def test_queue_does_not_hide_archives_after_fiftieth_item(self):
        store = handoff.Store(self.conf['handoff_dir'])
        for i in range(55):
            handoff.save_progress(store.root, f'x{i}.example', 'probekits', f'https://x{i}.example', {'items': []})
        self.assertEqual(len(self.call('queue')[1]), 55)

    def test_submission_attempt_survives_new_context_and_blocks_restore(self):
        code, saved = self.call('archive', data=self.payload())
        self.assertEqual(code, 200, saved)
        code, attempted = self.call('submission-attempt', data={'id': saved['id']})
        self.assertEqual(code, 200, attempted)
        self.assertEqual(attempted['status'], '结果未知')
        self.assertEqual(self.call('queue')[1], [])
        self.assertEqual(self.call('item', 'id=' + saved['id'])[0], 409)
        self.assertEqual(self.call('archive', data=self.payload())[0], 409)

    def test_unconfirmed_mapping_is_not_reported_as_only_verification(self):
        payload = self.payload()
        payload['frames'][0]['steps'][0]['fields'][0]['needs_confirmation'] = True
        code, saved = self.call('archive', data=payload)
        self.assertEqual(code, 200, saved)
        self.assertFalse(saved['archive']['only_verification'])


    def test_locator_only_verification_and_consent_values_are_not_saved(self):
        payload = self.payload()
        fields = payload['frames'][0]['steps'][0]['fields']
        fields.extend([
            dict(label='Code', inputType='text', value='NEVER_STORE_OTP',
                 locator=dict(autocomplete='one-time-code', id='code')),
            dict(label='Confirm', inputType='checkbox', value=True, checked=True,
                 locator=dict(name='consent', id='terms')),
        ])
        code, saved = self.call('archive', data=payload)
        self.assertEqual(code, 200, saved)
        record = handoff.Store(self.conf['handoff_dir']).load(saved['id'])
        cleaned = record['archive']['frames'][0]['steps'][0]['fields'][-2:]
        for field in cleaned:
            self.assertIn('skipped', field)
            self.assertNotIn('value', field)
            self.assertNotIn('checked', field)

    def test_same_product_domain_unknown_cannot_be_requeued_at_another_url(self):
        code, saved = self.call('archive', data=self.payload())
        self.assertEqual(code, 200, saved)
        store = handoff.Store(self.conf['handoff_dir'])
        record = store.load(saved['id'])
        record.update(status='结果未知', attempted_at=handoff.stamp())
        store.save(record)
        payload = self.payload()
        payload['url'] = 'https://x.example/alternate'
        payload['frames'][0]['url'] = payload['url']
        self.assertEqual(self.call('archive', data=payload)[0], 409)
        self.assertEqual(len(handoff.Store(self.conf['handoff_dir']).rows()), 1)

    def test_ordinary_snapshot_uses_archive_sensitive_filter_before_persistence(self):
        frame = self.payload()['frames'][0]
        frame.update(id='synthetic-consent', site='probekits', source_domain='x.example')
        frame['steps'][0]['fields'].append(dict(label='Confirm', inputType='checkbox', value=True, checked=True,
                                               locator=dict(name='agree_terms', id='consent')))
        code, result = self.call('snapshot', data=frame)
        self.assertEqual(code, 200, result)
        code, snapshots = self.call('snapshots', 'source=x.example&url=https://x.example/submit')
        self.assertEqual(code, 200)
        saved = snapshots[0]['steps'][0]['fields'][-1]
        self.assertEqual(saved.get('skipped'), 'sensitive')
        self.assertNotIn('checked', saved)
        self.assertNotIn('value', saved)


if __name__ == '__main__':
    unittest.main()
