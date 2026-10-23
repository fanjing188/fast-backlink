"""公开源码包必须与私有资产备份分开，候选包可在空目录直接安装。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class PublicPackageTests(unittest.TestCase):
    def test_symlinked_source_folder_cannot_bundle_outside_files(self):
        with tempfile.TemporaryDirectory(prefix='backlink-symlink-') as temp:
            root = Path(temp)
            source = root / 'source'
            source.mkdir()
            (source / 'bk.py').write_text('# synthetic boundary fixture\n')
            (source / 'config.example.json').write_text('{}')
            (source / 'package.json').write_text('{"license":"MIT"}')
            private = root / 'private'
            private.mkdir()
            (private / 'do-not-copy.txt').write_text('PRIVATE_FIXTURE')
            (source / 'tools').symlink_to(private, target_is_directory=True)
            output = root / 'must-not-exist.zip'
            result = subprocess.run([sys.executable, str(ROOT / 'tools/package_public.py'), '--source', str(source),
                                     '--local-candidate', '--output', str(output)], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0, '源码目录本身是软链时不得遍历外部文件')
            self.assertFalse(output.exists())

    def test_publication_is_blocked_without_license_confirmation(self):
        with tempfile.TemporaryDirectory(prefix='backlink-license-') as temp:
            output = Path(temp) / 'public.zip'
            source = Path(temp) / 'unlicensed-source'
            source.mkdir()
            (source / 'package.json').write_text('{"license":"UNLICENSED","private":true}')
            result = subprocess.run([sys.executable, str(ROOT / 'tools/package_public.py'), '--source', str(source), '--output', str(output)],
                                    text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('license', result.stderr.lower())
            self.assertFalse(output.exists())

    def test_local_candidate_is_clean_and_installs_after_extraction(self):
        tool = ROOT / 'tools/package_public.py'
        self.assertTrue(tool.is_file(), '缺少清洁源码包生成入口')
        with tempfile.TemporaryDirectory(prefix='backlink-public-') as temp:
            temp = Path(temp)
            output = temp / 'candidate.zip'
            result = subprocess.run([sys.executable, str(tool), '--local-candidate', '--output', str(output)],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with zipfile.ZipFile(output) as archive:
                self.assertIsNone(archive.testzip())
                names = archive.namelist()
                self.assertNotIn('config.json', names)
                self.assertNotIn('rules/learned.json', names)
                self.assertFalse(any(name.startswith(('kits/', 'runs/', 'docs/growth/', 'docs/releases/')) for name in names))
                manifest = json.loads(archive.read('SOURCE-MANIFEST.json'))
                self.assertEqual(manifest['status'], 'NOT_FOR_PUBLICATION')
                for name, digest in manifest['files'].items():
                    self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), digest)
                archive.extractall(temp / 'source')
            env = {**os.environ, 'HOME': str(temp / 'user'), 'PYTHON': sys.executable}
            result = subprocess.run(['sh', str(temp / 'source/scripts/install.sh'), '--prefix', str(temp / 'app'),
                                     '--bin-dir', str(temp / 'bin')], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(temp / 'bin/backlink-kit'), 'doctor'], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)['code_verified'])
            result = subprocess.run([sys.executable, '-m', 'unittest',
                                     'tests.test_kit.PlanTests.test_mapping_and_options',
                                     'tests.test_sources.LibraryTests.test_manual_precedence_and_evidence_accumulates'],
                                    cwd=temp / 'source', env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, '清洁源码的测试不能依赖私有config或产品包：' + result.stderr)
