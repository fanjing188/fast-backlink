"""终端安装入口：网络用本地发布夹具，所有程序与数据仅写临时用户目录。"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from tools.distribution import payload

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == 'darwin', '一键安装仅支持 macOS')
class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='backlink-setup-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home with spaces'
        self.prefix = self.home / 'custom app'
        self.bin = self.home / 'bin'
        self.shims = self.root / 'commands'
        self.shims.mkdir()
        self.script = self.root / 'setup.sh'
        shutil.copy2(ROOT / 'scripts/setup.sh', self.script)
        self.responses = self.root / 'responses.json'
        self.mapping = {}
        self.env = {**os.environ, 'HOME': str(self.home), 'PYTHON': sys.executable,
                    'BK_PROTECT_REAL': '1', 'SETUP_RESPONSES': str(self.responses),
                    'PATH': str(self.shims) + os.pathsep + os.environ.get('PATH', '')}
        curl = self.shims / 'curl'
        curl.write_text(f'#!{sys.executable}\n' + '''import json, os, pathlib, shutil, sys
args = sys.argv[1:]
url = next(arg for arg in args if arg.startswith('https://'))
target = args[args.index('-o') + 1]
shutil.copyfile(json.loads(pathlib.Path(os.environ['SETUP_RESPONSES']).read_text())[url], target)
''')
        curl.chmod(0o755)

    def run_setup(self, *args, explicit=True):
        self.responses.write_text(json.dumps(self.mapping))
        command = ['sh', str(self.script), '--no-open', '--bin-dir', str(self.bin)]
        if explicit:
            command += ['--prefix', str(self.prefix)]
        return subprocess.run([*command, *args], env=self.env, capture_output=True, text=True, timeout=30)

    def release(self, *, corrupt=False, unsafe=False, marker=b''):
        files = payload(ROOT)
        files['README.md'] += marker
        files['SOURCE-MANIFEST.json'] = json.dumps({'status': 'RELEASE_SOURCE', 'version': '1.0.2',
            'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}}).encode()
        archive = self.root / 'fast-backlink-1.0.2.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            for name, raw in files.items():
                bundle.writestr(name, raw)
            if unsafe:
                bundle.writestr('../escaped.txt', 'must not be extracted')
        sums = self.root / 'SHA256SUMS'
        sums.write_text(('0' * 64 if corrupt else hashlib.sha256(archive.read_bytes()).hexdigest()) + '  ' + archive.name + '\n')
        metadata = self.root / 'release.json'
        metadata.write_text('{"tag_name":"v1.0.2"}')
        self.mapping.update({
            'https://api.github.com/repos/fanjing188/fast-backlink/releases/latest': str(metadata),
            'https://github.com/fanjing188/fast-backlink/releases/download/v1.0.2/' + archive.name: str(archive),
            'https://github.com/fanjing188/fast-backlink/releases/download/v1.0.2/SHA256SUMS': str(sums),
        })

    def test_online_latest_install_verifies_release_and_keeps_config_on_repeat(self):
        self.release()
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('安装完成', result.stdout)
        previous = (self.prefix / 'current').resolve()
        config = self.prefix / 'config.json'
        before = config.read_bytes()
        note = self.prefix / 'data/personal.txt'
        note.write_text('keep my data')
        self.release(marker=b'\nSynthetic newer release\n')
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(config.read_bytes(), before)
        self.assertEqual(note.read_text(), 'keep my data')
        self.assertTrue((self.prefix / 'extension/manifest.json').is_file())
        self.assertNotEqual((self.prefix / 'current').resolve(), previous)
        rollback = subprocess.run([str(self.bin / 'backlink-kit'), 'rollback'], env=self.env, capture_output=True, text=True)
        self.assertEqual(rollback.returncode, 0, rollback.stderr)
        self.assertEqual((self.prefix / 'current').resolve(), previous)
        self.assertEqual(note.read_text(), 'keep my data')

    def test_existing_managed_command_reuses_original_installation(self):
        self.assertEqual(self.run_setup('--source', str(ROOT)).returncode, 0)
        result = self.run_setup('--source', str(ROOT), explicit=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.home / '.local/share/backlink-kit').exists())
        doctor = subprocess.run([str(self.bin / 'backlink-kit'), 'doctor'], env=self.env, capture_output=True, text=True)
        self.assertEqual(json.loads(doctor.stdout)['prefix'], str(self.prefix))

    def test_bad_checksum_or_archive_escape_never_starts_installation(self):
        for corrupt, unsafe in [(True, False), (False, True)]:
            with self.subTest(corrupt=corrupt, unsafe=unsafe):
                self.release(corrupt=corrupt, unsafe=unsafe)
                result = self.run_setup('--version', 'v1.0.2')
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.prefix.exists())
                self.assertFalse((self.bin / 'backlink-kit').exists())
                self.assertFalse(list(self.root.rglob('escaped.txt')))

    def test_managed_python_stays_private_and_does_not_edit_shell_profile(self):
        self.home.mkdir()
        profile = self.home / '.zshrc'
        profile.write_text('# keep my settings\n')
        installer = self.root / 'install-uv.sh'
        uv = f'#!{sys.executable}\n' + '''import os, pathlib, sys
root = pathlib.Path(os.environ['UV_PYTHON_INSTALL_DIR'])
python = root / 'fixture/bin/python3.11'
if sys.argv[1:3] == ['python', 'install']:
    assert '--no-bin' in sys.argv
    python.parent.mkdir(parents=True, exist_ok=True)
    if not python.exists(): python.symlink_to(sys.executable)
else:
    assert sys.argv[1:3] == ['python', 'find']
    print(python)
'''
        installer.write_text('set -eu\nmkdir -p "$UV_UNMANAGED_INSTALL"\ncat > "$UV_UNMANAGED_INSTALL/uv" <<\'UV\'\n' + uv + '\nUV\nchmod +x "$UV_UNMANAGED_INSTALL/uv"\n')
        self.mapping['https://astral.sh/uv/install.sh'] = str(installer)
        result = self.run_setup('--source', str(ROOT), '--managed-python')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(Path(str(self.prefix) + '-runtime/python/fixture/bin/python3.11').is_file())
        self.assertEqual(profile.read_text(), '# keep my settings\n')
        self.assertFalse((self.bin / 'python3').exists())

    def test_new_product_registers_homepage_without_manual_config_edit(self):
        self.assertEqual(self.run_setup('--source', str(ROOT)).returncode, 0)
        command = str(self.bin / 'backlink-kit')
        created = subprocess.run([command, 'kits', 'new', 'myproduct', '--url', 'https://product.example/'],
                                 env=self.env, capture_output=True, text=True)
        self.assertEqual(created.returncode, 0, created.stderr)
        config = self.prefix / 'config.json'
        self.assertEqual(json.loads(config.read_text())['sites']['myproduct']['domain'], 'product.example')
        kit = json.loads((self.prefix / 'data/kits/myproduct/kit.json').read_text())
        self.assertEqual(kit['fields']['url']['value'], 'https://product.example/')
        before = config.read_bytes()
        invalid = subprocess.run([command, 'kits', 'new', 'other', '--url', 'https://' + 'user:password@' + 'example.test/'],
                                 env=self.env, capture_output=True, text=True)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse((self.prefix / 'data/kits/other').exists())
