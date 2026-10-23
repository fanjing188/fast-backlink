"""安装脚本只在临时前缀演练，不接触个人安装、真实资产或浏览器配置。"""
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import time
import unittest
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='backlink-install-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'home with spaces'
        self.prefix = self.home / 'app'
        self.bin = self.home / 'bin'
        self.env = {**os.environ, 'HOME': str(self.home), 'PYTHON': sys.executable, 'BK_PROTECT_REAL': '1'}

    def script(self, name, *extra):
        script = ROOT / 'scripts' / (name + '.sh')
        self.assertTrue(script.is_file(), '缺少公开安装脚本：' + name)
        return subprocess.run(['sh', str(script), '--prefix', str(self.prefix), '--bin-dir', str(self.bin), *extra],
                              env=self.env, text=True, capture_output=True)

    def test_install_creates_usable_isolated_command_without_private_config(self):
        result = self.script('install')
        self.assertEqual(result.returncode, 0, result.stderr)
        conf = json.loads((self.prefix / 'config.json').read_text())
        self.assertEqual(conf['sites'], {})
        self.assertFalse(conf['ai']['enabled'])
        self.assertNotRegex(json.dumps(conf), r'/(Users|home)/[A-Za-z0-9._-]+/')
        self.assertTrue((self.prefix / 'current/extension/manifest.json').is_file())
        extension = self.prefix / 'extension'
        self.assertTrue((extension / 'manifest.json').is_file())
        self.assertFalse(extension.is_symlink(), '浏览器入口不能经过会固定到旧发布目录的软链')
        doctor = subprocess.run([str(self.bin / 'backlink-kit'), 'doctor'], env=self.env, text=True, capture_output=True)
        self.assertEqual(doctor.returncode, 0, doctor.stderr)
        self.assertEqual(json.loads(doctor.stdout)['extension'], str(extension))
        self.assertFalse((self.prefix / 'current/config.json').exists())
        self.assertFalse((self.prefix / 'current/kits/probekits.json').exists())
        help_result = subprocess.run([str(self.bin / 'backlink-kit'), '--help'], env=self.env, text=True, capture_output=True)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn('handoff', help_result.stdout)
        self.assertEqual((self.prefix.stat().st_mode & 0o777), 0o700)
        self.assertIn('BK_HANDOFF_TOKEN_FILE=', (self.bin / 'backlink-kit').read_text(), '不能退回别的个人安装令牌')

    def test_quickstart_product_check_is_read_only_and_reports_missing_fields(self):
        self.assertEqual(self.script('install').returncode, 0)
        command = str(self.bin / 'backlink-kit')
        created = subprocess.run([command, 'kits', 'new', 'myproduct'],
                                 env=self.env, text=True, capture_output=True)
        self.assertEqual(created.returncode, 0, created.stderr)
        kit = self.prefix / 'data/kits/myproduct/kit.json'
        original = kit.read_bytes()
        for arguments in (['kits', 'check'], ['kits', '--check']):
            with self.subTest(arguments=arguments):
                result = subprocess.run([command, *arguments], env=self.env, text=True, capture_output=True)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn('myproduct', json.loads(result.stdout))
                self.assertTrue(json.loads(result.stdout)['myproduct']['errors'])
                self.assertEqual(kit.read_bytes(), original, '检查不能重建或覆盖产品草稿')

    def test_relative_asset_export_stays_in_callers_directory(self):
        self.assertEqual(self.script('install').returncode, 0)
        result = subprocess.run([str(self.bin / 'backlink-kit'), 'assets', 'export', '--output', 'my-assets.zip'],
                                cwd=self.home, env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.home / 'my-assets.zip').is_file(), '备份不能偷偷写进会被卸载的程序版本目录')
        self.assertFalse((self.prefix / 'current/my-assets.zip').exists())

    def test_update_preserves_assets_and_can_roll_back(self):
        self.assertEqual(self.script('install').returncode, 0)
        previous = (self.prefix / 'current').resolve()
        browser_path = (self.prefix / 'extension').resolve()
        background = (browser_path / 'background.js').read_bytes()
        config = (self.prefix / 'config.json').read_bytes()
        asset = self.prefix / 'data/saved-asset.json'
        asset.write_text('{"human":"keep me"}')
        source = self.home / 'new source'
        shutil.copytree(previous, source)
        with (source / 'bk.py').open('a') as stream:
            stream.write('\n# next validated release\n')
        with (source / 'extension/background.js').open('a') as stream:
            stream.write('\n// 隔离测试的新扩展版本\n')
        result = self.script('update', '--source', str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual((self.prefix / 'current').resolve(), previous)
        self.assertEqual((self.prefix / 'extension').resolve(), browser_path)
        self.assertEqual((browser_path / 'background.js').read_bytes(), (source / 'extension/background.js').read_bytes())
        self.assertEqual((self.prefix / 'config.json').read_bytes(), config)
        self.assertEqual(asset.read_text(), '{"human":"keep me"}')
        result = subprocess.run([str(self.bin / 'backlink-kit'), 'rollback'], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.prefix / 'current').resolve(), previous)
        self.assertEqual((browser_path / 'background.js').read_bytes(), background)

    def test_legacy_install_gets_stable_extension_on_update(self):
        self.assertEqual(self.script('install').returncode, 0)
        shutil.rmtree(self.prefix / 'extension')
        result = self.script('update', '--source', str(ROOT))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.prefix / 'extension/background.js').read_bytes(), (ROOT / 'extension/background.js').read_bytes())

    def test_modified_or_symlinked_browser_entry_is_not_overwritten(self):
        self.assertEqual(self.script('install').returncode, 0)
        current = (self.prefix / 'current').resolve()
        extension = self.prefix / 'extension'
        target = extension / 'background.js'
        original = target.read_bytes()
        target.write_text('// 用户自己的修改\n')
        result = self.script('update', '--source', str(ROOT))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), '// 用户自己的修改\n')
        self.assertEqual((self.prefix / 'current').resolve(), current)
        target.write_bytes(original)
        outside = self.home / 'outside extension'
        extension.rename(outside)
        extension.symlink_to(outside, target_is_directory=True)
        result = self.script('update', '--source', str(ROOT))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((outside / 'background.js').read_bytes(), original)
        self.assertEqual((self.prefix / 'current').resolve(), current)

    def test_failed_activation_restores_both_code_and_browser_entry(self):
        self.assertEqual(self.script('install').returncode, 0)
        previous = (self.prefix / 'current').resolve()
        background = (self.prefix / 'extension/background.js').read_bytes()
        source = self.home / 'next source'
        shutil.copytree(previous, source)
        with (source / 'extension/background.js').open('a') as stream:
            stream.write('\n// 新候选\n')
        probe = '''
from pathlib import Path
from unittest.mock import patch
import os, sys, manage_install as m
prefix, source = map(Path, sys.argv[1:])
release = m.stage(prefix, source)
replace = os.replace
def fail_activation(src, dst):
    if Path(dst) == prefix / 'current': raise OSError('synthetic activation failure')
    return replace(src, dst)
with patch.object(m.os, 'replace', side_effect=fail_activation):
    try: m.switch(prefix, release)
    except OSError: pass
    else: raise AssertionError('activation should fail')
'''
        result = subprocess.run([sys.executable, '-c', probe, str(self.prefix), str(source)],
                                env={**self.env, 'PYTHONPATH': str(ROOT / 'tools')}, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.prefix / 'current').resolve(), previous)
        self.assertEqual((self.prefix / 'extension/background.js').read_bytes(), background)

    def test_symlinked_release_parent_blocks_all_management_writes(self):
        self.assertEqual(self.script('install').returncode, 0)
        outside = self.home / 'outside releases'
        (self.prefix / 'releases').rename(outside)
        (self.prefix / 'releases').symlink_to(outside, target_is_directory=True)
        before = sorted(path.name for path in outside.iterdir())
        result = self.script('install')
        self.assertNotEqual(result.returncode, 0, 'releases父目录软链不能变成隐式外部写入')
        self.assertEqual(sorted(path.name for path in outside.iterdir()), before)

    def test_corrupted_previous_release_cannot_be_activated(self):
        self.assertEqual(self.script('install').returncode, 0)
        previous = (self.prefix / 'current').resolve()
        source = self.home / 'next source'
        shutil.copytree(previous, source)
        with (source / 'bk.py').open('a') as stream:
            stream.write('\n# another release\n')
        self.assertEqual(self.script('update', '--source', str(source)).returncode, 0)
        current = (self.prefix / 'current').resolve()
        marker = (self.prefix / '.installation.json').read_bytes()
        (previous / 'bk.py').write_text('raise RuntimeError("corrupted")\n')
        result = subprocess.run([str(self.bin / 'backlink-kit'), 'rollback'], env=self.env, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0, '不能把已损坏的旧版本当作回滚点')
        self.assertEqual((self.prefix / 'current').resolve(), current)
        self.assertEqual((self.prefix / '.installation.json').read_bytes(), marker)

    def test_explicit_source_is_retained_for_next_default_update(self):
        self.assertEqual(self.script('install').returncode, 0)
        source = self.home / 'new source'
        shutil.copytree((self.prefix / 'current').resolve(), source)
        with (source / 'bk.py').open('a') as stream:
            stream.write('\n# retained update source\n')
        self.assertEqual(self.script('update', '--source', str(source)).returncode, 0)
        current = (self.prefix / 'current').resolve()
        result = subprocess.run([str(self.bin / 'backlink-kit'), 'update'], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.prefix / 'current').resolve(), current, '默认更新不能悄悄切回安装时的旧来源')

    def test_downloaded_source_update_script_uses_its_own_source(self):
        self.assertEqual(self.script('install').returncode, 0)
        old = (self.prefix / 'current').resolve()
        source = self.home / 'downloaded source'
        shutil.copytree(old, source)
        with (source / 'bk.py').open('a') as stream:
            stream.write('\n# downloaded source\n')
        result = subprocess.run(['sh', str(source / 'scripts/update.sh'), '--prefix', str(self.prefix)],
                                env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual((self.prefix / 'current').resolve(), old)

    def test_uninstall_retains_configuration_and_assets_by_default(self):
        self.assertEqual(self.script('install').returncode, 0)
        conf = (self.prefix / 'config.json').read_bytes()
        asset = self.prefix / 'data/human-notes.txt'
        asset.write_text('Preserve this asset')
        result = self.script('uninstall', '--yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.bin / 'backlink-kit').exists())
        self.assertFalse((self.prefix / 'current').exists())
        self.assertFalse((self.prefix / 'releases').exists())
        self.assertFalse((self.prefix / 'extension').exists())
        self.assertEqual((self.prefix / 'config.json').read_bytes(), conf)
        self.assertEqual(asset.read_text(), 'Preserve this asset')
        self.assertEqual(self.script('install').returncode, 0, '保留的数据必须支持重新安装')
        self.assertEqual(asset.read_text(), 'Preserve this asset')

    def test_reinstall_retains_identity_and_assets_but_uses_new_default_source(self):
        self.assertEqual(self.script('install').returncode, 0)
        old_meta = json.loads((self.prefix / '.installation.json').read_text())
        source = self.home / 'source B'
        shutil.copytree((self.prefix / 'current').resolve(), source)
        with (source / 'bk.py').open('a') as stream:
            stream.write('\n# reinstalled from source B\n')
        config = self.prefix / 'config.json'
        conf = json.loads(config.read_text())
        conf['sites'] = {'kept-product': {'domain': 'fixture.example'}}
        config.write_text(json.dumps(conf))
        saved_config = config.read_bytes()
        asset = self.prefix / 'data/human-notes.txt'
        asset.write_text('Keep this asset through reinstall')
        token = self.prefix / 'token'
        token.write_text('synthetic-test-token')
        self.assertEqual(self.script('uninstall', '--yes').returncode, 0)
        alternate_bin = self.home / 'ignored alternate bin'
        result = self.script('install', '--source', str(source), '--bin-dir', str(alternate_bin))
        self.assertEqual(result.returncode, 0, result.stderr)
        reinstalled = (self.prefix / 'current').resolve()
        command = self.bin / 'backlink-kit'
        self.assertIn('# backlink-kit managed: ' + old_meta['id'] + '\n', command.read_text())
        self.assertFalse((alternate_bin / 'backlink-kit').exists())
        result = subprocess.run([str(command), 'update'], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.prefix / 'current').resolve(), reinstalled, '重装后的默认更新不得退回来源A')
        meta = json.loads((self.prefix / '.installation.json').read_text())
        self.assertEqual(meta['source'], str(source.resolve()))
        self.assertEqual(meta['id'], old_meta['id'])
        self.assertEqual(meta['bin_dir'], old_meta['bin_dir'])
        self.assertEqual(config.read_bytes(), saved_config)
        self.assertEqual(asset.read_text(), 'Keep this asset through reinstall')
        self.assertEqual(token.read_text(), 'synthetic-test-token')
        result = subprocess.run([str(command), 'doctor'], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['source'], str(source.resolve()))

    def test_installed_service_runs_and_blocks_update_until_stopped(self):
        self._service_holds_runtime(['start'])

    def test_legacy_serve_entry_also_holds_runtime_lock(self):
        self._service_holds_runtime(['handoff', 'serve'])

    def _service_holds_runtime(self, actions):
        self.assertEqual(self.script('install').returncode, 0)
        command = str(self.bin / 'backlink-kit')
        probe = self.home / 'startup-probe'
        probe.mkdir()
        (probe / 'sitecustomize.py').write_text('import faulthandler\nfaulthandler.dump_traceback_later(2, repeat=True)\n')
        service_env = {**self.env, 'PYTHONPATH': str(probe) + os.pathsep + self.env.get('PYTHONPATH', '')}
        process = subprocess.Popen([command, *actions, '--port', '0'], env=service_env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        info = self.prefix / 'data/handoff/server.json'
        try:
            for _ in range(100):
                if info.exists() or process.poll() is not None:
                    break
                time.sleep(0.05)
            self.assertIsNone(process.poll(), '安装后的服务不应提前退出')
            self.assertTrue(info.is_file(), '安装后的启动命令应登记真实本机服务')
            address = json.loads(info.read_text())['url']
            with urlopen(Request(address + 'api/health', headers={'X-Fast-Backlink': '1'}), timeout=5) as response:
                self.assertEqual(response.status, 200)
            status = subprocess.run([command, 'fb', 'status'], env=self.env, text=True, capture_output=True)
            self.assertEqual(status.returncode, 0, '服务运行时，普通CLI读回仍应可用：' + status.stderr)
            result = self.script('update')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('busy', result.stderr)
        finally:
            missing_registration = not info.is_file()
            process.terminate()
            _, diagnostics = process.communicate(timeout=10)
            if missing_registration:
                # 只输出隔离测试进程的栈，不回显stdout中的本机令牌地址。
                print('[startup-timeout] ' + diagnostics, file=sys.stderr)
        self.assertFalse(info.exists(), '退出后清理服务登记，不能留下伪在线状态')

    def test_failed_update_keeps_current_release_and_user_data(self):
        self.assertEqual(self.script('install').returncode, 0)
        current = (self.prefix / 'current').resolve()
        source = self.home / 'broken source'
        shutil.copytree(current, source)
        (source / 'bk.py').write_text('raise RuntimeError("broken release")\n')
        result = self.script('update', '--source', str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.prefix / 'current').resolve(), current)
        self.assertTrue((self.prefix / 'config.json').is_file())

    def test_incomplete_management_candidate_keeps_installed_commands_usable(self):
        for name in ('manage_install.py', 'distribution.py'):
            for damage in ('missing', 'broken'):
                with self.subTest(name=name, damage=damage):
                    case = self.home / (name + '-' + damage)
                    self.prefix, self.bin = case / 'app', case / 'bin'
                    self.assertEqual(self.script('install').returncode, 0)
                    previous = (self.prefix / 'current').resolve()
                    good_source = case / 'good source'
                    shutil.copytree(previous, good_source)
                    with (good_source / 'bk.py').open('a') as stream:
                        stream.write('\n# known usable rollback point\n')
                    self.assertEqual(self.script('update', '--source', str(good_source)).returncode, 0)
                    current = (self.prefix / 'current').resolve()
                    marker = (self.prefix / '.installation.json').read_bytes()
                    config = (self.prefix / 'config.json').read_bytes()
                    asset = self.prefix / 'data/human-notes.txt'
                    asset.write_text('Keep this asset')
                    command = str(self.bin / 'backlink-kit')
                    source = case / 'source'
                    shutil.copytree(current, source)
                    target = source / 'tools' / name
                    if damage == 'missing':
                        target.unlink()
                    else:
                        target.write_text('raise RuntimeError("broken management dependency")\n')
                    result = subprocess.run([command, 'update', '--source', str(source)],
                                            env=self.env, text=True, capture_output=True)
                    self.assertNotEqual(result.returncode, 0, '管理入口或依赖不完整时不得激活候选')
                    result = self.script('install', '--source', str(source))
                    self.assertNotEqual(result.returncode, 0, '重复安装也必须验证候选管理入口')
                    self.assertEqual((self.prefix / 'current').resolve(), current)
                    self.assertEqual((self.prefix / '.installation.json').read_bytes(), marker)
                    self.assertEqual((self.prefix / 'config.json').read_bytes(), config)
                    self.assertEqual(asset.read_text(), 'Keep this asset')
                    for action in ('--help', 'doctor'):
                        result = subprocess.run([command, action], env=self.env, text=True, capture_output=True)
                        self.assertEqual(result.returncode, 0, result.stderr)
                    result = subprocess.run([command, 'rollback'], env=self.env, text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual((self.prefix / 'current').resolve(), previous)

    def test_git_update_path_works_with_real_offline_repository(self):
        self.assertEqual(self.script('install').returncode, 0)
        source = self.home / 'release repo'
        shutil.copytree((self.prefix / 'current').resolve(), source)
        with (source / 'bk.py').open('a') as stream:
            stream.write('\n# git-delivered release\n')
        for args in (['init', '-b', 'main'], ['add', '--all'],
                     ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false',
                      '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']):
            result = subprocess.run(['git', '-C', str(source), *args], env=self.env, capture_output=True)
            self.assertEqual(result.returncode, 0, '隔离Git夹具创建失败')
        old = (self.prefix / 'current').resolve()
        result = self.script('update', '--repo', source.resolve().as_uri(), '--ref', 'main')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual((self.prefix / 'current').resolve(), old)

    def test_unowned_prefix_and_foreign_command_are_not_overwritten(self):
        self.prefix.mkdir(parents=True)
        note = self.prefix / 'important.txt'
        note.write_text('leave this alone')
        self.assertNotEqual(self.script('install').returncode, 0)
        self.assertEqual(note.read_text(), 'leave this alone')
        result = self.script('uninstall', '--yes')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(note.is_file())

    def test_foreign_command_is_not_overwritten(self):
        self.bin.mkdir(parents=True)
        command = self.bin / 'backlink-kit'
        command.write_text('another application')
        self.assertNotEqual(self.script('install').returncode, 0)
        self.assertEqual(command.read_text(), 'another application')
        self.assertFalse((self.prefix / 'current').exists())
        self.assertFalse((self.prefix / '.installation.json').exists(), '冲突失败不能遗留错误安装身份')
        alternate = self.home / 'alternate bin'
        result = self.script('install', '--bin-dir', str(alternate))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((alternate / 'backlink-kit').is_file())
        self.assertEqual(command.read_text(), 'another application')

    def test_install_from_download_does_not_require_git(self):
        tools = self.home / 'only shell tools'
        tools.mkdir(parents=True)
        dirname = shutil.which('dirname')
        assert dirname is not None, '隔离安装测试需要系统dirname'
        (tools / 'dirname').symlink_to(dirname)
        (tools / 'sh').symlink_to('/bin/sh')
        self.env['PATH'] = str(tools)
        result = self.script('install')
        self.assertEqual(result.returncode, 0, result.stderr)
