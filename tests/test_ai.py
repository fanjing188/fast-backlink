"""AI 兜底的离线测试：标准 OpenAI 兼容接口、字段过滤、白名单校验和缓存。"""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import bk
from backlink_kit import ai, kits
from backlink_kit import core as c
from backlink_kit import handoff as h
from tests.test_kit import kit
from tests.support import fixture_config


class FakeModel:
    """最小的 /v1/chat/completions 假服务；记录请求体和请求头。"""

    def __init__(self, text=None, status=200, raw=None, usage=None):
        self.text = text if text is not None else json.dumps({'suggestions': [
            {'i': 0, 'key': 'url', 'conf': 0.95, 'why': 'website'},
            {'i': 1, 'key': 'how_did_you_hear', 'conf': 0.9, 'why': 'qa'},
            {'i': 4, 'key': 'no_such_key', 'conf': 1},
            {'i': 99, 'key': 'name', 'conf': 1},
        ]})
        self.status, self.raw, self.usage = status, raw, usage or {'prompt_tokens': 10, 'completion_tokens': 5}
        self.requests, self.headers = [], []
        model = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                size = int(self.headers.get('Content-Length', '0'))
                model.requests.append(json.loads(self.rfile.read(size)))
                model.headers.append(dict(self.headers))
                if model.raw is not None:
                    body = model.raw
                elif model.status != 200:
                    body = json.dumps({'error': {'message': 'nope'}}).encode()
                else:
                    body = json.dumps({'choices': [{'message': {'content': model.text}}],
                                       'usage': model.usage}).encode()
                self.send_response(model.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self):
        return f'http://127.0.0.1:{self.server.server_port}/v1'

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class AITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.conf = fixture_config()
        for key in ('directories', 'ledger', 'handoff_dir', 'runs_dir', 'sources_dir',
                    'raw_sources_dir', 'snapshots_dir', 'logs_dir', 'settings_dir', 'stage_dir'):
            self.conf[key] = str(self.root / key)
        self.conf['learned_file'] = str(self.root / 'learned.json')
        self.conf['kits_dir'] = str(self.root / 'kits')
        (Path(self.conf['kits_dir']) / 'probekits').mkdir(parents=True)
        data = json.loads(json.dumps(kit()))
        c.atomic_json(Path(self.conf['kits_dir']) / 'probekits' / 'kit.json',
                      {'schema_version': 2, 'site': 'probekits',
                       'fields': {k: {'value': v['value'], 'variants': {str(len(v['value'])): v['value']}}
                                  for k, v in data['fields'].items()},
                       'assets': [], 'qa_overrides': {}})
        # 已知答案来自显式合成资料，不依赖个人事实的出厂默认值。
        kits.save_profile(self.conf, {'fields': {}, 'qa': {'How did you hear about us': 'Google search'}})
        for folder in ('handoff_dir', 'runs_dir', 'raw_sources_dir', 'sources_dir', 'settings_dir'):
            Path(self.conf[folder]).mkdir()
        c.write_csv(self.conf['directories'], ['domain'], [])
        c.write_csv(self.conf['ledger'], ['record_id'], [])
        self.addCleanup(self._clear_env)
        self.payload = {
            'site': 'probekits', 'source_domain': 'seeded.example', 'fingerprint': 'fp1',
            'fields': [
                {'index': 0, 'label': 'Your Website', 'inputType': 'url'},
                {'index': 1, 'label': 'How did you hear about us?', 'inputType': 'text'},
                {'index': 2, 'label': 'Password', 'inputType': 'password'},
                {'index': 3, 'label': 'Submit your logo', 'inputType': 'file'},
                {'index': 4, 'label': 'Twitter handle', 'inputType': 'text'},
                {'index': 5, 'label': 'I agree to the terms', 'inputType': 'checkbox'},
                {'index': 6, 'label': 'How do you charge?', 'inputType': 'radio',
                 'options': ['Free', 'Freemium', 'Paid']},
                {'index': 7, 'label': 'Which tests?', 'inputType': 'select-multiple',
                 'widget': 'select-multiple', 'options': ['mouse test', 'keyboard test']},
            ],
        }

    def _clear_env(self):
        os.environ.pop('BACKLINK_AI_KEY', None)

    def configure(self, model=None, **extra):
        fake = model or FakeModel()
        self.addCleanup(fake.close)
        self.conf['ai'] = {'enabled': True, 'base_url': fake.base_url, 'model': 'fake-model',
                           'api_key': 'test-key', 'timeout_ms': 5000, **extra}
        return fake

    def test_provider_request_identifies_the_application(self):
        fake = self.configure()
        ai.AIAdvisor(self.conf).suggest(self.payload, use_cache=False)
        self.assertEqual(fake.headers[0].get('User-Agent'), 'Fast-Backlink/1.0')

    def test_disabled_and_unconfigured_are_distinct(self):
        self.conf['ai'] = {'enabled': False}
        advisor = ai.AIAdvisor(self.conf)
        self.assertFalse(advisor.status()['enabled'])
        self.assertEqual(advisor.suggest(self.payload)['reason'], 'disabled')

        self.conf['ai'] = {'enabled': True, 'base_url': 'https://api.example.com/v1',
                           'model': 'm', 'api_key_env': 'AI_KEY_MISSING', 'api_key_file': '/nope'}
        with self.assertRaisesRegex(ValueError, 'ai_not_configured'):
            ai.AIAdvisor(self.conf).suggest(self.payload)

    def test_key_resolution_env_and_file(self):
        path = self.root / 'key'
        path.write_text('from-file\n')
        cfg = ai.settings({'ai': {'enabled': True, 'base_url': 'https://api.example.com/v1',
                                  'model': 'm', 'api_key_env': 'BACKLINK_AI_KEY',
                                  'api_key_file': str(path)}})
        self.assertEqual(ai.resolve_api_key(cfg), 'from-file')
        os.environ['BACKLINK_AI_KEY'] = 'from-env'
        self.assertEqual(ai.resolve_api_key(cfg), 'from-env')
        cfg['api_key'] = 'direct'
        self.assertEqual(ai.resolve_api_key(cfg), 'direct')

    def test_catalog_and_field_filtering(self):
        self.conf['ai']['send_value_previews'] = True
        available = ai.catalog(self.conf, 'probekits')
        self.assertIn('url', available)
        self.assertIn('url_bare', available)
        self.assertIn('domain', available)
        self.assertIn('how_did_you_hear', available)
        self.assertNotIn('password', available)
        self.assertEqual(available['email']['preview'], '<已配置>')
        hidden = ai.catalog({**self.conf, 'ai': {'send_value_previews': False}}, 'probekits')
        self.assertEqual(hidden['url']['preview'], '<hidden>')
        settings = ai.settings(self.conf)
        self.assertEqual(ai._preview('mail me at a@b.com', 'note', settings), '<已配置>')
        self.assertEqual(ai._preview('call +1 415 555 0100', 'note', settings), '<已配置>')

        fields = [ai.clean_field(item) for item in self.payload['fields']]
        cleaned = [item for item in fields if item]
        self.assertEqual([item['i'] for item in cleaned], [0, 1, 4, 6, 7])
        self.assertEqual(cleaned[0]['label'], 'Your Website')

        prompt = ai.build_prompt(cleaned, available, ai.settings(self.conf))
        self.assertIn('Your Website', prompt)
        self.assertIn('how_did_you_hear', prompt)
        self.assertNotIn('Password', prompt)
        self.assertNotIn('fanjing188', prompt)
        self.assertIn('"suggestions"', prompt)

    def test_catalog_includes_source_memory_but_not_sensitive(self):
        self.conf['ai']['send_value_previews'] = True
        c.atomic_json(Path(self.conf['sources_dir']) / 'seeded.example.json', {
            'schema_version': 1, 'domain': 'seeded.example',
            'memories': {'probekits': {'labels': {}, 'fields': [
                {'label': 'X handle', 'key': 'twitter', 'value': '@probekits'},
                {'label': 'Password', 'key': 'password', 'value': 'secret'},
            ]}},
        })
        available = ai.catalog(self.conf, 'probekits', 'seeded.example')
        self.assertEqual(available['twitter']['preview'], '@probekits')
        self.assertNotIn('password', available)

    def test_extract_json_tolerates_fences_and_validation_whitelists(self):
        fenced = '说明\n```json\n{"suggestions":[{"i":0,"key":"url","conf":0.9}]}\n```\n结束'
        parsed = ai.extract_json(fenced)
        self.assertEqual(parsed['suggestions'][0]['key'], 'url')
        with self.assertRaisesRegex(ValueError, 'ai_bad_response'):
            ai.extract_json('不是 JSON')

        available = {'url': {}, 'name': {}}
        fields = [{'i': 0}, {'i': 1}, {'i': 2}, {'i': 3}]
        result = ai.validate_suggestions({'suggestions': [
            {'i': 0, 'key': 'url', 'conf': 0.9},
            {'i': 0, 'key': 'name', 'conf': 0.4},
            {'i': 1, 'key': 'nope', 'conf': 1},
            {'i': 99, 'key': 'name', 'conf': 1},
            {'i': 2, 'key': None, 'conf': 2, 'why': 'x' * 200},
            {'i': '3', 'key': 'name', 'conf': '0.8'},
        ]}, fields, available, ai.settings(self.conf))
        self.assertEqual([item['i'] for item in result], [0, 2, 3])
        self.assertEqual(result[0]['key'], 'url')  # 同索引保留最高置信度
        self.assertIsNone(result[1]['key'])
        self.assertEqual(result[1]['conf'], 1.0)
        self.assertLessEqual(len(result[1]['why']), 80)
        self.assertEqual(result[2]['conf'], 0.8)

    def test_suggest_uses_standard_endpoint_and_cache(self):
        fake = self.configure()
        advisor = ai.AIAdvisor(self.conf)
        answer = advisor.suggest(self.payload)
        self.assertEqual(len(fake.requests), 1)
        request = fake.requests[0]
        self.assertEqual(request['model'], 'fake-model')
        self.assertEqual(request['messages'][0]['role'], 'system')
        self.assertIn('Your Website', request['messages'][1]['content'])
        self.assertNotIn('Password', request['messages'][1]['content'])
        self.assertEqual(fake.headers[0].get('Authorization'), 'Bearer test-key')
        # 非法 key、越界索引、敏感字段、文件字段都不应出现。
        self.assertEqual([(item['i'], item['key']) for item in answer['suggestions']],
                         [(0, 'url'), (1, 'how_did_you_hear')])
        self.assertEqual(answer['cached'], 0)

        again = advisor.suggest(self.payload)
        self.assertEqual(len(fake.requests), 1)  # 全部命中缓存
        self.assertEqual(again['cached'], 5)
        self.assertEqual(again['requested'], 0)

    def test_http_error_is_reported_and_not_cached(self):
        fake = self.configure(FakeModel(status=401))
        advisor = ai.AIAdvisor(self.conf)
        with self.assertRaisesRegex(ValueError, 'ai_http_401'):
            advisor.suggest(self.payload)
        self.assertEqual(len(fake.requests), 1)

    def test_api_endpoint_ai_status_and_suggest(self):
        fake = self.configure()
        self.conf['ai']['auto_apply'] = True
        config = self.root / 'config.json'
        c.atomic_json(config, self.conf)
        token = 'k' * 40
        token_file = self.root / 'token'
        token_file.write_text(token + '\n')
        server, base = h.make_server(self.conf, 0, token_file)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)

        def call(endpoint, data=None):
            from urllib.request import Request, urlopen
            body = json.dumps(data).encode() if data is not None else None
            request = Request(base + 'api/' + endpoint, data=body,
                              headers={'X-Fast-Backlink': '1', 'Content-Type': 'application/json'})
            with urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())

        status, info = call('ai')
        self.assertEqual(status, 200)
        self.assertTrue(info['enabled'])
        self.assertTrue(info['configured'])
        self.assertTrue(info['auto_apply'])
        self.assertEqual(info['auto_apply_min_confidence'], 0.9)
        self.assertNotIn('test-key', json.dumps(info))

        status, answer = call('ai_suggest', self.payload)
        self.assertEqual(status, 200)
        self.assertEqual(answer['suggestions'][0]['key'], 'url')
        self.assertTrue(answer['auto_apply'])
        self.assertEqual(len(fake.requests), 1)

        status, report = call('report')
        self.assertEqual(status, 200)
        self.assertEqual(report['ai']['calls'], 1)
        self.assertEqual(report['ai']['suggestions'], 2)

    def test_check_command_returns_json(self):
        fake = self.configure()
        result = ai.check(self.conf, 'probekits', ['Your Website'])
        self.assertTrue(result['ok'])
        self.assertEqual(result['suggestions'][0]['key'], 'url')
        self.assertEqual(result['fields'], ['Your Website'])
        # 冒烟测试不能用缓存冒充连通性
        ai.check(self.conf, 'probekits', ['Your Website'])
        self.assertEqual(len(fake.requests), 2)

    def test_cli_ai_check(self):
        self.configure()
        config = self.root / 'config.json'
        c.atomic_json(config, self.conf)
        import contextlib
        import io
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = bk.main(['--config', str(config), 'ai', 'check', '--site', 'probekits',
                            '--field', 'Your Website'])
        self.assertEqual(code, 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result['ok'])
        self.assertEqual(result['suggestions'][0]['key'], 'url')


if __name__ == '__main__':
    unittest.main()
