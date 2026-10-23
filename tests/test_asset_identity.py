"""素材重排或重新上传不能悄悄替换存档里的文件。"""
import base64
import unittest
from tests import test_extension_api as fixture


class IdentityTests(unittest.TestCase):
    setUp = fixture.ApiTests.setUp
    call = fixture.ApiTests.call

    def upload(self, name, tail=b''):
        png = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000010000000100806000000') + b'\0' * 24 + tail
        code, result = self.call('asset', data={'site': 'probekits', 'key': 'logo', 'name': name,
                                'data': base64.b64encode(png).decode()})
        self.assertEqual(code, 200, result)

    def test_manifest_exposes_stable_identity_and_file_rejects_changed_content(self):
        self.upload('logo-16.png')
        original = self.call('kit', 'site=probekits')[1]['assets'][0]
        self.assertEqual(len(original['sha256']), 64)
        self.upload('other-16.png')
        self.upload('logo-16.png', b'changed')
        assets = self.call('kit', 'site=probekits')[1]['assets']
        current = next(a for a in assets if a['assetId'] == original['assetId'])
        self.assertNotEqual(current['id'], original['id'])
        self.assertNotEqual(current['sha256'], original['sha256'])
        code, _ = self.call('file', f"site=probekits&id={current['id']}&sha256={original['sha256']}")
        self.assertEqual(code, 409)


if __name__ == '__main__':
    unittest.main()
