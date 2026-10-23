"""登录候选AI：使用既有兼容客户端，模型看不到账号或OAuth地址。"""
import json
import tempfile
import unittest
from backlink_kit import ai
from tests.test_ai import FakeModel


class AuthAITests(unittest.TestCase):
    def test_real_client_uses_existing_engine_without_private_data(self):
        from backlink_kit import auth_ai
        with tempfile.TemporaryDirectory() as folder:
            model = FakeModel(text=json.dumps({'i': 1}))
            self.addCleanup(model.close)
            advisor = ai.AIAdvisor({'settings_dir': folder, 'ai': {
                'enabled': True, 'base_url': model.base_url, 'model': 'synthetic-login', 'api_key': 'synthetic-key'}})
            reply = auth_ai.suggest(advisor, {'kind': 'login', 'email': 'private@example.test',
                'url': 'https://accounts.google.com/?code=private-code', 'candidates': [
                    {'id': 'first', 'action': 'login', 'label': 'Sign in'},
                    {'id': 'second', 'action': 'google', 'label': 'Continue with Google private@example.test https://x.test/?code=secret'},
                    {'id': 'deny', 'action': 'consent', 'label': 'Allow Gmail access'}]})
            self.assertEqual(reply['id'], 'second')
            raw = json.dumps(model.requests)
            for secret in ('private@example.test', 'private-code', 'code=secret', 'Allow Gmail access'):
                self.assertNotIn(secret, raw)
            self.assertEqual(model.requests[0]['model'], 'synthetic-login')
            self.assertIn('untrusted', model.requests[0]['messages'][0]['content'])

    def test_model_cannot_choose_outside_candidates_or_select_accounts(self):
        from backlink_kit import auth_ai
        with tempfile.TemporaryDirectory() as folder:
            model = FakeModel(text='{"i": 999, "script": "clickConsent()"}')
            self.addCleanup(model.close)
            advisor = ai.AIAdvisor({'settings_dir': folder, 'ai': {
                'enabled': True, 'base_url': model.base_url, 'model': 'synthetic-login', 'api_key': 'synthetic-key'}})
            payload = {'kind': 'login', 'candidates': [{'id': 'first', 'action': 'login', 'label': 'Sign in'}]}
            self.assertIsNone(auth_ai.suggest(advisor, payload)['id'])
            before = len(model.requests)
            for kind in ('google', 'manual', 'form'):
                self.assertIsNone(auth_ai.suggest(advisor, {**payload, 'kind': kind})['id'])
            self.assertEqual(len(model.requests), before)
            self.assertIsNone(auth_ai.suggest(advisor, {'kind': 'login', 'candidates': [
                {'id': 'private@example.test', 'action': 'login', 'label': 'Sign in'},
                {'id': 'account', 'action': 'account', 'email': 'private@example.test'}]})['id'])
            self.assertEqual(len(model.requests), before)

    def test_disabled_engine_does_not_make_a_request(self):
        from backlink_kit import auth_ai
        with tempfile.TemporaryDirectory() as folder:
            advisor = ai.AIAdvisor({'settings_dir': folder, 'ai': {'enabled': False}})
            self.assertIsNone(auth_ai.suggest(advisor, {'kind': 'login', 'candidates': []})['id'])
