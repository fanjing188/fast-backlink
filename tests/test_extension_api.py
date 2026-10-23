"""扩展接口的集成测试：起真实的带令牌服务，只用 HTTP 访问，不碰浏览器。"""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import bk
from backlink_kit import core as c, handoff as h
from tests.test_kit import kit
from tests.support import fixture_config


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.conf = fixture_config()
        self.conf.update({key: str(self.root / key) for key in
                          ('directories', 'ledger', 'handoff_dir', 'runs_dir', 'sources_dir',
                           'raw_sources_dir', 'snapshots_dir', 'logs_dir', 'settings_dir', 'stage_dir')})
        self.conf['learned_file'] = str(self.root / 'learned.json')
        self.conf['kits_dir'] = str(self.root / 'kits')
        (Path(self.conf['kits_dir']) / 'probekits').mkdir(parents=True)
        data = json.loads(json.dumps(kit()))
        c.atomic_json(Path(self.conf['kits_dir']) / 'probekits' / 'kit.json',
                      {'schema_version': 2, 'site': 'probekits',
                       'fields': {k: {'value': v['value'], 'variants': {str(len(v['value'])): v['value']}} for k, v in data['fields'].items()},
                       'assets': [], 'qa_overrides': {}})
        for folder in ('handoff_dir', 'runs_dir', 'raw_sources_dir', 'sources_dir'):
            Path(self.conf[folder]).mkdir()
        c.write_csv(self.conf['directories'], ['domain'], [])
        c.write_csv(self.conf['ledger'], ['record_id'], [])
        self.config = self.root / 'config.json'
        c.atomic_json(self.config, self.conf)
        token = 'k' * 40
        self.token_file = self.root / 'token'
        self.token_file.write_text(token + '\n')
        self.server, self.base = h.make_server(self.conf, 0, self.token_file)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)

    def call(self, endpoint, query='', data=None, method=None):
        url = self.base + 'api/' + endpoint + (('?' + query) if query else '')
        body = json.dumps(data).encode() if data is not None else None
        request = Request(url, data=body, method=method or ('POST' if body else 'GET'),
                          headers={'X-Fast-Backlink': '1', 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=10) as response:
                raw = response.read()
                mime = response.headers.get('Content-Type', '')
                return response.status, (raw if 'image' in mime else json.loads(raw))
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_loopback_startup_does_not_require_reverse_dns(self):
        with patch('socket.getfqdn', side_effect=AssertionError('回环服务启动不能等待外部名称解析')):
            server, base = h.make_server(self.conf, 0, self.token_file)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            self.assertEqual(server.server_name, '127.0.0.1')
            self.assertGreater(server.server_port, 0)
            with urlopen(Request(base + 'api/health', headers={'X-Fast-Backlink': '1'}), timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.load(response)['name'], 'fast-backlink')
        finally:
            server.shutdown()
            server.server_close()

    def test_health_rules_and_kit_payload_hide_paths(self):
        status, health = self.call('health')
        self.assertEqual(status, 200)
        self.assertEqual(health['name'], 'fast-backlink')
        status, rules = self.call('rules')
        self.assertEqual(status, 200)
        for key in ('labels', 'sensitive', 'navigation', 'learned', 'fieldRules'):
            self.assertIn(key, rules)
        # 匹配分层第 5 层要用加权同义词和排他词，缺了会退回旧的 labels.json。
        self.assertIn('url', rules['fieldRules']['keys'])
        self.assertIn('twitter', rules['fieldRules']['keys']['url']['exclude'])
        self.assertEqual(rules['fieldRules']['autocomplete']['email'], 'email')
        status, payload = self.call('kit', 'site=probekits')
        self.assertEqual(status, 200)
        self.assertEqual(payload['fields']['name']['value'], 'ProbeKits')
        self.assertIn('qa', payload)
        self.assertNotIn(str(self.root), json.dumps(payload))

    def test_ai_configuration_is_private_and_effective_for_fill_and_login_requests(self):
        from tests.test_ai import FakeModel
        model = FakeModel(text='{"ok":true}')
        self.addCleanup(model.close)
        draft = dict(base_url=model.base_url, model='combined-backend', api_key='synthetic-private-key')
        code, result = self.call('ai_test', data=draft)
        self.assertEqual(code, 200, result)
        self.assertTrue(result['ok'])
        path = Path(self.conf['settings_dir']) / 'ai-config.json'
        self.assertFalse(path.exists(), '测试连通不能保存草稿')
        self.assertNotIn('synthetic-private-key', json.dumps(result))
        code, result = self.call('ai_config', data={**draft, 'enabled': True})
        self.assertEqual(code, 200, result)
        self.assertNotIn('synthetic-private-key', json.dumps(result))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        code, status = self.call('ai')
        self.assertEqual(code, 200, status)
        self.assertTrue(status['configured'])
        self.assertTrue(status['has_key'])
        self.assertNotIn('api_key', status)
        model.text = '{"suggestions":[{"i":0,"key":"url","conf":0.99}]}'
        code, result = self.call('ai_suggest', data=dict(site='probekits', source_domain='combined.example',
            fields=[dict(index=0, label='Your Website', inputType='url')]))
        self.assertEqual(code, 200, result)
        self.assertEqual(result['suggestions'][0]['key'], 'url')
        model.text = '{"i":0}'
        code, result = self.call('auth_suggest', data=dict(kind='login', candidates=[
            dict(id='login-candidate', action='google', label='Continue with Google')]))
        self.assertEqual(code, 200, result)
        self.assertEqual(result['id'], 'login-candidate')
        self.assertIn('Select a login navigation button', model.requests[-1]['messages'][0]['content'])
        self.assertEqual(model.headers[-1]['Authorization'], 'Bearer synthetic-private-key')
        self.assertNotIn('synthetic-private-key', json.dumps(result))

    def test_library_import_preview_accepts_large_body_without_mutation(self):
        before = list(Path(self.conf['sources_dir']).glob('*.json'))
        code, result = self.call('library_import_preview', data=dict(format='txt',
            text=' ' * 300000 + 'https://combined.example/submit'))
        self.assertEqual(code, 200, result)
        self.assertEqual(result['added'], 1)
        self.assertEqual(before, list(Path(self.conf['sources_dir']).glob('*.json')))
        self.assertEqual(self.call('library_template')[0], 200)

    def test_batch_manual_attempt_survives_large_archive_and_abandon_over_http(self):
        from backlink_kit import sources
        store = sources.SourceStore(self.conf['sources_dir'])
        store.update('combined.example', 'screen', dict(status='可投',
            submit_url='https://combined.example/submit', scenario='directory', cost='free',
            dr='25', dr_date=str(c.today()), fit_sites='probekits', backlink_required=False),
            sources.evidence('synthetic:combined', by='manual'))
        selection = dict(site='probekits', domains=['combined.example'])
        code, batch = self.call('batch_start', data=selection)
        self.assertEqual(code, 200, batch)
        code, jobs = self.call('batch_claim', data={'owner': 'a' * 32})
        self.assertEqual(code, 200, jobs)
        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        frame = dict(frame_id=0, url='https://combined.example/step2', steps=[dict(fields=[
            dict(label='Description', value='x' * 300000),
            dict(label='Confirm', inputType='checkbox', value=True, checked=True,
                 locator=dict(name='agree_terms'))])])
        code, result = self.call('batch_result', data=dict(job, result='manual', frames=[frame]))
        self.assertEqual(code, 200, result)
        self.assertTrue(result['archive_saved'])
        saved = h.Store(self.conf['handoff_dir']).load(job['id'])
        self.assertEqual(saved['submit_url'], frame['url'])
        clean = saved['archive']['frames'][0]['steps'][0]['fields'][-1]
        self.assertNotIn('value', clean)
        self.assertNotIn('checked', clean)
        code, result = self.call('submission-attempt', data={'id': job['id']})
        self.assertEqual((code, result['status']), (200, '结果未知'))
        code, result = self.call('batch_resolve', data=dict(batch_id=batch['id'], id=job['id'], result='abandoned'))
        self.assertEqual(code, 200, result)
        code, preview = self.call('batch_preview', data=selection)
        self.assertEqual(code, 200, preview)
        self.assertEqual(preview['eligible'], [])
        code, status = self.call('batch_status', 'id=' + batch['id'])
        self.assertEqual(code, 200, status)
        self.assertTrue(status['jobs'][0]['attempted_at'])
        self.assertEqual(status['jobs'][0]['state'], 'abandoned')

    def test_unconfirmed_personal_facts_are_not_factory_answers(self):
        from backlink_kit import ai, kits
        status, payload = self.call('kit', 'site=probekits')
        self.assertEqual(status, 200)
        self.assertEqual(payload['qa'], {}, '未知个人事实不能通过扩展自动填写')
        self.assertFalse(any(item['kind'] == 'qa' for item in ai.catalog(self.conf, 'probekits').values()))
        self.assertEqual(kits.today_profile(self.conf)['qa'], {})
        kits.save_profile(self.conf, {'fields': {}, 'qa': {'Team size': '3'}})
        self.assertEqual(self.call('kit', 'site=probekits')[1]['qa'], {'Team size': '3'}, '保留明确保存的答案')

    def test_kit_save_cannot_overwrite_another_products_materials(self):
        original = self.call('kit', 'site=probekits')[1]['fields']
        status, reply = self.call('kit', data={'site': 'probekits', 'kit': {
            'schema_version': 2, 'site': 'raumlens', 'fields': {'name': {'value': 'Other product'}}}})
        self.assertEqual(status, 409)
        self.assertIn('site_mismatch', str(reply))
        self.assertEqual(self.call('kit', 'site=probekits')[1]['fields'], original)

    def test_editor_roundtrip_preserves_registered_media_and_site_answers(self):
        from backlink_kit import kits

        directory = Path(self.conf['kits_dir']) / 'probekits'
        media = directory / 'assets/logo.png'
        media.parent.mkdir()
        media.write_bytes(Path(kit()['images'][0]['path']).read_bytes())
        current, _ = kits.load(self.conf, 'probekits')
        current['assets'] = [kits.asset_record(media, 'logo', ident='registered-logo', alt='Original logo')]
        current['qa_overrides'] = {'Team size': '4', 'Funding': ''}
        kits.save(self.conf, 'probekits', current)
        payload = self.call('kit', 'site=probekits')[1]
        payload['fields']['name']['value'] = 'Edited product name'
        payload['assets'][0]['alt'] = 'Updated logo alt'
        self.assertEqual(self.call('kit', data={'site': 'probekits', 'kit': payload})[0], 200)
        saved = json.loads((directory / 'kit.json').read_text())
        self.assertEqual(saved['assets'][0]['id'], 'registered-logo')
        self.assertEqual(saved['assets'][0]['file'], 'logo.png')
        self.assertEqual(saved['assets'][0]['alt'], 'Updated logo alt')
        self.assertEqual(saved['qa_overrides'], {'Team size': '4', 'Funding': ''})
        self.assertEqual(kits.resolve_asset(self.conf, 'probekits', 'registered-logo')[1].read_bytes(), media.read_bytes())

    def test_unknown_site_and_endpoint_are_rejected(self):
        self.assertEqual(self.call('kit', 'site=nope')[0], 409)
        self.assertEqual(self.call('nope')[0], 409)

    def test_snapshot_roundtrip_and_sensitive_stripped(self):
        snapshot = {'id': 'a' * 8, 'created_at': '2026-10-22T10:00:00+08:00', 'site': 'probekits',
                    'source_domain': 'seesaw.website', 'url': 'https://seesaw.website/submit',
                    'form_fingerprint': 'fp1', 'step_index': 0, 'by': 'extension', 'complete': False,
                    'steps': [{'fields': [{'locator': {'name': 'pname'}, 'label': 'Product name', 'key': 'name', 'value': 'ProbeKits'},
                                          {'locator': {'name': 'otp'}, 'label': '验证码', 'key': 'captcha', 'value': '1234'}]}]}
        status, saved = self.call('snapshot', data=snapshot)
        self.assertEqual(status, 200)
        status, listed = self.call('snapshots', 'source=seesaw.website&url=https://seesaw.website/submit')
        self.assertEqual(status, 200)
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]['steps'][0]['fields'][0]['value'], 'ProbeKits')
        self.assertNotIn('1234', json.dumps(listed))

    def test_logs_batch_settings_learn_and_report(self):
        entries = [{'ts': '2026-10-22T10:00:00.000Z', 'level': 'info', 'cat': 'perf', 'msg': 'run_summary',
                    'source': 'seesaw.website', 'site': 'probekits', 'fields_total': 10, 'filled_auto': 9,
                    'needs_confirm': 1, 'unmatched': 0, 'honeypot': 1, 'captcha': 1, 'ms': 2500},
                   {'ts': '2026-10-22T10:00:00.100Z', 'level': 'info', 'cat': 'match', 'msg': 'unmatched',
                    'source': 'seesaw.website', 'site': 'probekits', 'field': {'label': 'Twitter handle'}},
                   {'ts': '2026-10-22T10:00:01.000Z', 'level': 'info', 'cat': 'restore', 'msg': 'restored',
                    'source': 'seesaw.website', 'site': 'probekits'}]
        status, written = self.call('logs', data={'entries': entries})
        self.assertEqual(status, 200)
        self.assertEqual(written['written'], 3)
        status, read = self.call('logs', 'days=7&cat=perf')
        self.assertEqual(status, 200)
        self.assertEqual(len(read), 1)
        status, report = self.call('report', 'days=7')
        self.assertEqual(report['sources'][0]['filled_auto'], 9)
        self.assertEqual(report['unmatched_labels'][0]['label'], 'Twitter handle')
        self.assertEqual(report['restore_success_rate'], 1.0)
        status, settings = self.call('settings', data={'patch': {'auto_next': True, 'auto_next_sites': {'seesaw.website': False}}})
        self.assertTrue(settings['auto_next'])
        self.assertEqual(settings['auto_next_sites']['seesaw.website'], False)
        self.assertEqual(self.call('settings', data={'patch': {'nope': 1}})[0], 409)
        status, learned = self.call('learn', data={'label': 'Twitter handle', 'key': 'twitter', 'source': 'seesaw.website', 'site': 'probekits'})
        self.assertEqual(status, 200)
        self.assertIsNone(learned['promoted'])
        # 三个不同来源后升为全局规则，并出现在 rules 里。
        for domain in ('a.example', 'b.example'):
            self.call('learn', data={'label': 'Twitter handle', 'key': 'twitter', 'source': domain, 'site': 'probekits'})
        status, rules = self.call('rules')
        self.assertEqual(rules['learned']['twitter handle'], 'twitter')

    def test_reject_wrong_token_host_and_oversized_body(self):
        # 令牌不对时连路径都不算接口路径，按普通请求拒绝。
        wrong = Request(self.base.replace(self.token_file.read_text().strip(), 'z' * 40) + 'api/health',
                        headers={'X-Fast-Backlink': '1'})
        with self.assertRaises(HTTPError) as caught:
            urlopen(wrong, timeout=10)
        self.assertEqual(caught.exception.code, 403)
        no_header = Request(self.base + 'api/health')
        with self.assertRaises(HTTPError) as caught:
            urlopen(no_header, timeout=10)
        self.assertEqual(caught.exception.code, 403)
        big = Request(self.base + 'api/settings', data=b'x' * (512 * 1024),
                      headers={'X-Fast-Backlink': '1', 'Content-Type': 'application/json'})
        try:
            with urlopen(big, timeout=10) as response:
                self.fail('超限请求不应被接受：' + str(response.status))
        except HTTPError as exc:
            self.assertEqual(exc.code, 409)
        except (ConnectionResetError, BrokenPipeError, URLError):
            # 服务在读完请求体前就拒绝并关连接，客户端看到断管，同样算超限被挡。
            pass

    def test_kit_asset_upload_and_stage(self):
        import base64
        png = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000010000000100806000000')
        png += b'\x00' * 24
        status, saved = self.call('asset', data={'site': 'probekits', 'key': 'logo', 'name': 'logo-16.png',
                                                'data': base64.b64encode(png).decode(), 'alt': 'ProbeKits logo'})
        self.assertEqual(status, 200)
        self.assertEqual(saved['asset']['w'], 16)
        status, payload = self.call('kit', 'site=probekits')
        self.assertEqual([a['key'] for a in payload['assets']], ['logo'])
        status, staged = self.call('stage', 'site=probekits&id=0')
        self.assertTrue(Path(staged['path']).exists())
        self.assertTrue(str(staged['path']).startswith(self.conf['stage_dir']))
        self.assertEqual(self.call('stage', 'site=probekits&id=9')[0], 409)

    def test_queue_lists_handoff_items(self):
        store = h.Store(self.conf['handoff_dir'], self.conf)
        h.save_progress(store.root, 'x.example', 'probekits', 'https://x.example/submit', {'items': []})
        status, queue = self.call('queue', 'site=probekits')
        self.assertEqual(status, 200)
        self.assertEqual(queue[0]['site'], 'probekits')
        self.assertEqual(queue[0]['status'], '待处理')


if __name__ == '__main__':
    unittest.main()
