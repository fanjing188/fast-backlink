"""AI 设置：私有持久化、即时生效与不发送业务资料的连通测试。"""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from backlink_kit import ai
from tests.test_ai import FakeModel


class AIConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.conf = {'settings_dir': self.temp.name, 'ai': {
            'api_key_env': '', 'api_key_file': '', 'send_value_previews': False}}

    def test_save_is_private_redacted_and_effective_on_next_request(self):
        model = FakeModel(text='{"ok":true}')
        self.addCleanup(model.close)
        reply = ai.configure(self.conf, {'enabled': True, 'base_url': model.base_url,
            'model': 'synthetic-model', 'api_key': 'synthetic-secret', 'timeout_ms': 5000}, save=True)
        self.assertTrue(reply['configured'])
        self.assertNotIn('synthetic-secret', json.dumps(reply))
        saved = Path(self.temp.name) / 'ai-config.json'
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        advisor = ai.AIAdvisor(self.conf)
        self.assertEqual(advisor.cfg['model'], 'synthetic-model')
        self.assertFalse(advisor.cfg['send_value_previews'])
        ai.configure(self.conf, {'model': 'changed-model', 'api_key': ''}, save=True)
        self.assertEqual(ai.AIAdvisor(self.conf).cfg['api_key'], 'synthetic-secret')
        self.assertEqual(ai.AIAdvisor(self.conf).cfg['model'], 'changed-model')
        self.assertNotIn('api_key', ai.AIAdvisor(self.conf).status())

    def test_draft_connection_uses_real_client_without_saving_or_business_data(self):
        model = FakeModel(text='{"ok":true}')
        self.addCleanup(model.close)
        draft = {'base_url': model.base_url, 'model': 'draft-model', 'api_key': 'draft-secret'}
        result = ai.test_connection(self.conf, draft)
        self.assertTrue(result['ok'])
        self.assertEqual(result['model'], 'draft-model')
        self.assertGreaterEqual(result['ms'], 0)
        self.assertEqual(len(model.requests), 1)
        self.assertEqual(model.requests[0]['model'], 'draft-model')
        self.assertEqual(model.headers[0]['Authorization'], 'Bearer draft-secret')
        self.assertNotIn('draft-secret', json.dumps(result))
        self.assertNotIn('probekits', json.dumps(model.requests).lower())
        self.assertFalse((Path(self.temp.name) / 'ai-config.json').exists())
        self.assertFalse(ai.AIAdvisor(self.conf).status()['configured'])

    def test_connection_failure_is_safe_and_does_not_change_saved_configuration(self):
        model = FakeModel(status=401, raw=b'error containing draft-secret')
        self.addCleanup(model.close)
        result = ai.test_connection(self.conf, {'base_url': model.base_url,
            'model': 'draft-model', 'api_key': 'draft-secret'})
        self.assertFalse(result['ok'])
        self.assertIn('401', result['error'])
        self.assertNotIn('draft-secret', json.dumps(result))
        self.assertFalse((Path(self.temp.name) / 'ai-config.json').exists())

    def test_validation_preserves_saved_settings_and_prevents_old_key_leak(self):
        ai.configure(self.conf, {'base_url': 'https://api.example.test/v1',
            'model': 'saved', 'api_key': 'saved-secret'}, save=True)
        path = Path(self.temp.name) / 'ai-config.json'
        before = path.read_bytes()
        invalid = [{'base_url': 'http://remote.test/v1'}, {'base_url': ''.join(('https://', 'user:pass', '@remote.test'))},
            {'base_url': 'https://api.example.test/v1?key=secret'}, {'timeout_ms': 0},
            {'api_key_file': '/private/file'}, {'enabled': 'false'}, {'model': []},
            {'api_key': 'bad\nkey'}, {'base_url': 'https://another.test/v1'}]
        for patch in invalid:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                ai.configure(self.conf, patch, save=True)
            self.assertEqual(path.read_bytes(), before)
        ai.configure(self.conf, {'clear_api_key': True}, save=True)
        self.assertFalse(ai.AIAdvisor(self.conf).status()['has_key'])

    def test_provider_error_cannot_echo_key_into_fill_logs(self):
        model = FakeModel(status=401, raw=b'{"error":"echoed-secret"}')
        self.addCleanup(model.close)
        logs = []
        advisor = ai.AIAdvisor({**self.conf, 'ai': {'base_url': model.base_url,
            'model': 'safe-errors', 'api_key': 'echoed-secret'}}, logger=logs.append)
        with self.assertRaises(ValueError) as caught:
            advisor._call('Synthetic test')
        self.assertNotIn('echoed-secret', str(caught.exception))
        self.assertNotIn('echoed-secret', json.dumps(logs))

    def test_connection_never_follows_provider_redirects_with_a_key(self):
        redirected = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.send_response(302)
                self.send_header('Location', '/steal')
                self.end_headers()

            def do_GET(self):
                redirected.append(self.headers.get('Authorization'))
                self.send_response(200)
                self.end_headers()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        result = ai.test_connection(self.conf, {'base_url': f'http://127.0.0.1:{server.server_port}/v1',
            'model': 'redirect-test', 'api_key': 'redirect-key'})
        self.assertFalse(result['ok'])
        self.assertEqual(redirected, [], '接口重定向不能携带密钥访问另一地址')
