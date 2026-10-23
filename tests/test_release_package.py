"""正式源码包必须绑定已提交、版本一致的完整源码，不能发布脏候选。"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'tools/package_public.py'


class ReleasePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='backlink-release-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        files = {
            'bk.py': '# synthetic release fixture\n',
            'config.example.json': '{}',
            'package.json': json.dumps({'version': '1.0.0', 'license': 'MIT'}),
            'package-lock.json': json.dumps({'version': '1.0.0', 'packages': {'': {'version': '1.0.0'}}}),
            'extension/manifest.json': json.dumps({'manifest_version': 3, 'version': '1.0.0'}),
            'backlink_kit/extension_api.py': "VERSION = '1.0.0'\n",
            'LICENSE': (ROOT / 'LICENSE').read_text(),
            'extension/vendor/fbl/LICENSE': (ROOT / 'extension/vendor/fbl/LICENSE').read_text(),
            '.gitignore': 'rules/ignored.json\n',
        }
        for name, text in files.items():
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        self.git('init', '--initial-branch=main')
        self.git('config', 'user.name', 'Synthetic release fixture')
        self.git('config', 'user.email', 'fixture@example.test')
        self.git('add', '--', *files)
        self.git('commit', '-m', '合成夹具：固定源码')

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.source, stderr=subprocess.STDOUT, text=True).strip()

    def build(self, *extra):
        output = self.root / 'release.zip'
        result = subprocess.run([sys.executable, str(TOOL), '--source', str(self.source),
                                 '--release', '1.0.0', '--output', str(output), *extra],
                                capture_output=True, text=True)
        return result, output

    def test_release_records_exact_commit_and_verified_files(self):
        result, output = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(output) as archive:
            self.assertIsNone(archive.testzip())
            manifest = json.loads(archive.read('SOURCE-MANIFEST.json'))
            self.assertEqual(manifest['status'], 'RELEASE_SOURCE')
            self.assertEqual(manifest['version'], '1.0.0')
            self.assertEqual(manifest['source_commit'], self.git('rev-parse', 'HEAD'))
            for name, digest in manifest['files'].items():
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), digest)

    def test_dirty_release_is_rejected_without_creating_output(self):
        (self.source / 'bk.py').write_text('# uncommitted fixture\n')
        result, output = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('clean', result.stderr.lower())
        self.assertFalse(output.exists())

    def test_clean_version_drift_is_rejected(self):
        package = self.source / 'package.json'
        package.write_text(json.dumps({'version': '1.0.1', 'license': 'MIT'}))
        self.git('add', '--', 'package.json')
        self.git('commit', '-m', '合成夹具：版本不一致')
        result, output = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('version', result.stderr.lower())
        self.assertFalse(output.exists())

    def test_ignored_uncommitted_payload_cannot_enter_a_release(self):
        target = self.source / 'rules/ignored.json'
        target.parent.mkdir()
        target.write_text('{"synthetic":true}')
        self.assertEqual(self.git('status', '--porcelain'), '')
        result, output = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('committed', result.stderr.lower())
        self.assertFalse(output.exists())

    def test_local_candidate_flag_cannot_mark_an_official_release(self):
        result, output = self.build('--local-candidate')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.exists())
