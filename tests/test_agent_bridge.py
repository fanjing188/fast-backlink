"""Agent 命令通道：提交、长轮询、回执、超时取消和连接心跳。"""
import threading
import time
import unittest

from backlink_kit.agent_bridge import AgentBridge


class AgentBridgeTests(unittest.TestCase):
    def test_submit_next_complete_unblocks_cli(self):
        bridge = AgentBridge()
        result = {}
        thread = threading.Thread(target=lambda: result.update(bridge.submit('fill', {'site': 'probekits'}, wait=2)))
        thread.start()
        command = bridge.next(wait=1, version='1.0.0')
        self.assertEqual(command['action'], 'fill')
        self.assertEqual(command['args']['site'], 'probekits')
        bridge.complete(command['id'], {'counts': {'filled': 2}})
        thread.join(2)
        self.assertEqual(result['state'], 'done')
        self.assertEqual(result['result']['counts']['filled'], 2)
        status = bridge.status()
        self.assertTrue(status['connected'])
        self.assertTrue(status['polling'])
        self.assertEqual(status['version'], '1.0.0')

    def test_timeout_is_cancellable_and_never_runs_later(self):
        bridge = AgentBridge()
        result = bridge.submit('open', {'url': 'https://example.com/form'}, wait=0)
        self.assertEqual(result['state'], 'pending')
        self.assertEqual(bridge.cancel(result['id'])['state'], 'cancelled')
        self.assertIsNone(bridge.next(wait=0))

    def test_unknown_action_and_unknown_receipt(self):
        bridge = AgentBridge()
        with self.assertRaises(ValueError):
            bridge.submit('shell', {}, wait=0)
        with self.assertRaises(ValueError):
            bridge.complete('missing', {}, None)
        with self.assertRaises(ValueError):
            bridge.cancel('missing')

    def test_submit_rejects_invalid_args(self):
        bridge = AgentBridge()
        with self.assertRaises(ValueError):
            bridge.submit('status', ['not', 'a', 'dict'], wait=0)

    def test_status_before_any_extension_contact(self):
        status = AgentBridge().status()
        self.assertFalse(status['connected'])
        self.assertFalse(status['polling'])
        self.assertIsNone(status['last_seen_seconds'])
        self.assertIsNone(status['version'])

    def test_expired_command_is_not_delivered(self):
        bridge = AgentBridge()
        result = bridge.submit('fill', {}, wait=0)
        # 直接把创建时间拨到 TTL 之前，模拟 CLI 早已离开。
        bridge._commands[result['id']]['created_at'] -= 10_000
        self.assertIsNone(bridge.next(wait=0))
        self.assertEqual(bridge.snapshot(result['id'])['state'], 'error')

    def test_complete_after_cancel_keeps_cancelled_state(self):
        bridge = AgentBridge()
        result = bridge.submit('fill', {}, wait=0)
        bridge.cancel(result['id'])
        bridge.complete(result['id'], {'late': True})
        self.assertEqual(bridge.snapshot(result['id'])['state'], 'cancelled')

    def test_submit_wait_bounded(self):
        bridge = AgentBridge()
        started = time.monotonic()
        result = bridge.submit('status', {}, wait=0)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(result['state'], 'pending')


if __name__ == '__main__':
    unittest.main()
