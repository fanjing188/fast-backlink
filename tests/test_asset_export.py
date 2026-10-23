"""真实 CLI 导出与跨产品候选，全部使用临时资产副本。"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from backlink_kit import core, sources, kits
from tests.support import fixture_config


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.conf = fixture_config()
        self.conf['kits_dir'] = str(self.root / 'kits')
        self.conf['sites'] = {'probekits': {'domain': 'probekits.com', 'kit': 'probekits/kit.json'}}
        kitdir = self.root / 'kits/probekits'
        (kitdir / 'assets').mkdir(parents=True)
        (kitdir / 'assets/logo.png').write_bytes(b'fixture-logo-bytes')
        core.atomic_json(kitdir / 'kit.json', {'schema_version': 2, 'site': 'probekits', 'fields': {'name': {'value': 'ProbeKits'}},
            'assets': [{'id': 'logo-main', 'key': 'logo', 'file': 'logo.png', 'mime': 'image/png'}]})
        for key in ('sources_dir', 'ledger', 'directories', 'handoff_dir'):
            self.conf[key] = str(self.root / key)
        core.write_csv(self.conf['ledger'], ['record_id', 'source_domain', 'site', 'status'], [])
        core.write_csv(self.conf['directories'], ['domain'], [{'domain': 'x.example'}])
        self.config = self.root / 'config.json'
        core.atomic_json(self.config, self.conf)
        self.store = sources.SourceStore(self.conf['sources_dir'])
        self.store.update('x.example', 'history', {'record_id': 'one', 'site': 'oldproduct', 'status': 'public',
            'raw_href': 'https://oldproduct.example/'}, sources.evidence('proof.json'))
        self.store.update('x.example', 'memory', [{'label': 'Description', 'key': 'description', 'value': 'Old private description'}],
            sources.evidence('manual', by='manual'), 'oldproduct')

    def run_cli(self, *args):
        return subprocess.run([sys.executable, '-m', 'backlink_kit.assets', '--config', str(self.config), *args],
                              cwd=core.ROOT, text=True, capture_output=True)

    def test_export_preserves_all_records_and_manifest_hashes_without_overwrite(self):
        out = self.root / 'assets.zip'
        result = self.run_cli('export', '--output', str(out))
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response['sha256'], hashlib.sha256(out.read_bytes()).hexdigest())
        with zipfile.ZipFile(out) as archive:
            self.assertIsNone(archive.testzip())
            manifest = json.loads(archive.read('manifest.json'))
            for name, digest in manifest['files'].items():
                self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), digest)
            source = json.loads(archive.read('sources/x.example.json'))
            self.assertEqual(source['history'][0]['raw_href'], 'https://oldproduct.example/')
            self.assertIn('ledger.csv', archive.namelist())
            self.assertNotIn('config.json', archive.namelist())
            archive.extractall(self.root / 'restored')
        restored = {**self.conf, 'kits_dir': str(self.root / 'restored/kits')}
        asset, file = kits.resolve_asset(restored, 'probekits', 'logo-main')
        self.assertEqual(file.read_bytes(), b'fixture-logo-bytes')
        self.assertNotIn('source', asset)
        original = out.read_bytes()
        self.assertNotEqual(self.run_cli('export', '--output', str(out)).returncode, 0)
        self.assertEqual(out.read_bytes(), original)

    def test_new_product_reuses_platform_not_old_product_text_or_approval(self):
        result = self.run_cli('reuse', '--site', 'newproduct')
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = json.loads(result.stdout)
        self.assertEqual(rows[0]['source_domain'], 'x.example')
        self.assertEqual(rows[0]['previous_sites'], ['oldproduct'])
        self.assertIn('产品匹配需确认', rows[0]['checks'])
        self.assertNotIn('Old private description', result.stdout)
        self.assertEqual(json.loads(self.run_cli('reuse', '--site', 'oldproduct').stdout), [])


if __name__ == '__main__':
    unittest.main()
