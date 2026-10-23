"""配套技能的本地落盘入口；只用合成资料。"""
import json
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from backlink_kit import kits
from tests.support import legacy_kit


class OnboardingTests(unittest.TestCase):
    def test_project_skills_are_shipped_with_the_source_and_installation(self):
        from tools.distribution import payload
        root = Path(__file__).resolve().parents[1]
        files = payload(root)
        for name in ('fast-backlink-init', 'fast-backlink-product'):
            relative = f'skills/{name}/SKILL.md'
            self.assertTrue(relative in files, relative + ' 未进入安装白名单')
            self.assertTrue(files[relative].startswith(b'---\nname: ' + name.encode() + b'\n'))
        self.assertFalse(any('_profile.json' in name or name.endswith('answers.json') for name in files))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.conf = {'kits_dir': str(self.root / 'kits'), 'sites': {}}

    def bundle(self):
        directory = self.root / 'bundle'
        (directory / 'assets').mkdir(parents=True)
        data: dict = kits.from_v1('sample', legacy_kit())
        for asset in data['assets']:
            shutil.copy2(asset.pop('source'), directory / 'assets' / asset['file'])
        (directory / 'kit.json').write_text(json.dumps(data))
        config = self.root / 'config.json'
        config.write_text(json.dumps({**self.conf, 'directories': str(self.root / 'directories.csv')}))
        return config, directory

    def test_product_preview_and_import_copy_real_assets_and_register_only_new_site(self):
        from backlink_kit import onboarding
        config, bundle = self.bundle()
        before = config.read_bytes()
        preview = onboarding.import_product(config, bundle)
        self.assertFalse(preview['applied'])
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse(Path(self.conf['kits_dir']).exists())
        result = onboarding.import_product(config, bundle, apply=True)
        self.assertTrue(result['applied'])
        saved, target = kits.load({**self.conf, 'sites': {'sample': {}}}, 'sample')
        self.assertEqual(json.loads(config.read_text())['sites']['sample']['domain'], 'probekits.com')
        self.assertEqual(saved['fields']['name']['value'], 'ProbeKits')
        for asset in saved['assets']:
            original = bundle / 'assets' / asset['file']
            copied = target / 'assets' / asset['file']
            self.assertEqual(copied.read_bytes(), original.read_bytes())
            self.assertEqual(asset['sha256'], hashlib.sha256(copied.read_bytes()).hexdigest())
        with self.assertRaises(ValueError):
            onboarding.import_product(config, bundle, apply=True)

    def test_import_rejects_invalid_shapes_paths_missing_files_and_linked_media_before_writing(self):
        from backlink_kit import onboarding
        config, bundle = self.bundle()
        original = json.loads((bundle / 'kit.json').read_text())
        before = config.read_bytes()
        for replacement in [[], {'schema_version': 2, 'site': '../escape'},
                            {**original, 'assets': [{**original['assets'][0], 'file': '../escape.png'}]},
                            {**original, 'assets': [{**original['assets'][0], 'file': 'missing.png'}]}]:
            with self.subTest(replacement=replacement):
                (bundle / 'kit.json').write_text(json.dumps(replacement))
                with self.assertRaises(ValueError):
                    onboarding.import_product(config, bundle, apply=True)
                self.assertEqual(config.read_bytes(), before)
                self.assertFalse(Path(self.conf['kits_dir']).exists())
        (bundle / 'kit.json').write_text(json.dumps(original))
        logo = bundle / 'assets' / original['assets'][0]['file']
        logo.unlink()
        logo.symlink_to(legacy_kit()['images'][0]['path'])
        with self.assertRaises(ValueError):
            onboarding.import_product(config, bundle, apply=True)

    def test_module_cli_saves_all_identity_fields_and_imports_a_product_visible_to_api(self):
        from backlink_kit import core, extension_api
        config, bundle = self.bundle()
        profile = self.root / 'answers.json'
        profile.write_text(json.dumps({'fields': {'maker_name': 'Local Fixture', 'email': 'maker@example.test'}}))
        def run(*args):
            result = subprocess.run([sys.executable, '-m', 'backlink_kit.onboarding', '--config', str(config), *args],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return json.loads(result.stdout)
        self.assertEqual(set(run('profile-template')['fields']), set(kits.PROFILE_KEYS))
        saved = run('profile-save', '--file', str(profile))
        self.assertTrue(saved['saved'])
        self.assertNotIn('maker@example.test', json.dumps(saved))
        self.assertEqual(set(saved['fields']), set(kits.PROFILE_KEYS))
        self.assertFalse(run('product-import', '--bundle', str(bundle))['applied'])
        self.assertTrue(run('product-import', '--bundle', str(bundle), '--apply')['applied'])
        conf = core.load_config(config)
        conf.update({key: str(self.root / key) for key in
                     ('handoff_dir', 'snapshots_dir', 'logs_dir', 'settings_dir', 'stage_dir', 'learned_file')})
        payload = extension_api.ExtensionAPI(conf, None).kit_payload('sample')
        self.assertEqual(payload['fields']['name']['value'], 'ProbeKits')
        self.assertEqual(payload['profile']['maker_name'], 'Local Fixture')
        self.assertEqual(len(payload['assets']), 2)

    def test_incomplete_bundle_requires_explicit_draft_and_preserves_missing_facts(self):
        from backlink_kit import onboarding
        config, bundle = self.bundle()
        data = json.loads((bundle / 'kit.json').read_text())
        data['fields']['pricing'] = kits.variant('')
        (bundle / 'kit.json').write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            onboarding.import_product(config, bundle, apply=True)
        report = onboarding.import_product(config, bundle, apply=True, draft=True)
        self.assertFalse(report['valid'])
        self.assertTrue(report['errors'])
        saved = json.loads((Path(self.conf['kits_dir']) / 'sample/kit.json').read_text())
        self.assertEqual(saved['fields']['pricing']['value'], '')

    def test_config_failure_cleans_only_this_new_import_and_keeps_existing_products(self):
        from backlink_kit import onboarding
        config, bundle = self.bundle()
        existing = Path(self.conf['kits_dir']) / 'existing/kit.json'
        existing.parent.mkdir(parents=True)
        existing.write_text('untouched synthetic record')
        original = config.read_bytes()
        real_write = onboarding.atomic_json
        def write(path, data):
            if Path(path) == config:
                raise OSError('synthetic configuration failure')
            return real_write(path, data)
        with patch.object(onboarding, 'atomic_json', side_effect=write):
            with self.assertRaises(OSError):
                onboarding.import_product(config, bundle, apply=True)
        self.assertEqual(config.read_bytes(), original)
        self.assertEqual(existing.read_text(), 'untouched synthetic record')
        self.assertFalse((Path(self.conf['kits_dir']) / 'sample').exists())

    def test_parent_symlink_bundle_is_rejected(self):
        from backlink_kit import onboarding
        config, bundle = self.bundle()
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            onboarding.import_product(config, alias / 'bundle', apply=True)

    def test_invalid_or_truncated_png_is_rejected_even_in_draft_mode(self):
        from backlink_kit import onboarding
        config, bundle = self.bundle()
        logo = bundle / 'assets/logo.png'
        original = logo.read_bytes()
        for content in (b'not an image', original[:24], original[:-8]):
            logo.write_bytes(content)
            for draft in (False, True):
                with self.subTest(content=len(content), draft=draft), self.assertRaises(ValueError):
                    onboarding.import_product(config, bundle, apply=True, draft=draft)
        self.assertFalse(Path(self.conf['kits_dir']).exists())

    def test_product_writers_share_a_cross_process_config_lock(self):
        from backlink_kit.core import config_lock
        config, bundle = self.bundle()
        original = config.read_bytes()
        with config_lock(config):
            for command in ([sys.executable, '-m', 'backlink_kit.onboarding', '--config', str(config),
                             'product-import', '--bundle', str(bundle), '--apply'],
                            [sys.executable, 'bk.py', '--config', str(config), 'kits', 'new', 'other']):
                result = subprocess.run(command, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('配置正在更新', result.stdout + result.stderr)
                self.assertEqual(config.read_bytes(), original)
        self.assertFalse(Path(self.conf['kits_dir']).exists())

    def test_configuration_is_rechecked_after_staging_before_registration(self):
        from backlink_kit import onboarding
        config, bundle = self.bundle()
        rename = Path.rename
        def changed(source, target):
            result = rename(source, target)
            if Path(target).name == 'sample':
                current = json.loads(config.read_text())
                current['sites']['external-edit'] = {'domain': 'example.test', 'kit': 'external-edit/kit.json'}
                config.write_text(json.dumps(current))
            return result
        with patch.object(Path, 'rename', changed), self.assertRaises(ValueError):
            onboarding.import_product(config, bundle, apply=True)
        self.assertIn('external-edit', json.loads(config.read_text())['sites'])
        self.assertFalse((Path(self.conf['kits_dir']) / 'sample').exists())


    def test_profile_all_fields_are_saved_without_erasing_existing_answers(self):
        from backlink_kit import onboarding
        kits.save_profile(self.conf, {'fields': {'company': 'Existing Co', 'custom': 'keep'},
                                      'qa': {'Team size': '1'}, 'qa_overrides': {'Funding': ''}})
        saved = onboarding.save_identity(self.conf, {'fields': {'maker_name': 'Synthetic Maker', 'email': ''}})
        self.assertTrue(set(kits.PROFILE_KEYS).issubset(saved['fields']))
        self.assertEqual(saved['fields']['company'], 'Existing Co')
        self.assertEqual(saved['fields']['custom'], 'keep')
        self.assertEqual(saved['fields']['email'], '')
        self.assertEqual(saved['qa'], {'Team size': '1'})
        self.assertEqual(saved['qa_overrides'], {'Funding': ''})
        self.assertEqual(kits.profile(self.conf), saved)
        self.assertEqual(kits.profile_path(self.conf).stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError):
            onboarding.save_identity(self.conf, {'fields': {'email': {'value': 'invalid'}}})
        self.assertEqual(kits.profile(self.conf), saved)


if __name__ == '__main__':
    unittest.main()
