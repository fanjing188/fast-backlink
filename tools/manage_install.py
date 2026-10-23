#!/usr/bin/env python3
"""用户级安装管理；不要求sudo，不安装系统依赖，不修改浏览器或个人已有配置。"""
import argparse
from contextlib import contextmanager, nullcontext
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import urlsplit

from distribution import checked_path, payload

APP = 'backlink-kit'
DEFAULT_PREFIX = Path.home() / '.local/share' / APP
DEFAULT_BIN = Path.home() / '.local/bin'
SOURCE = Path(__file__).resolve().parents[1]


def write_json(path, value):
    fd, temp = tempfile.mkstemp(prefix='.bk-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def metadata(prefix):
    if prefix.is_symlink():
        raise ValueError('Installation prefix must not be a symlink')
    for name in ('.installation.json', '.install.lock', '.service.lock', 'releases', 'extension'):
        checked_path(prefix, prefix / name)
    value = json.loads((prefix / '.installation.json').read_text())
    if value.get('app') != APP or value.get('prefix') != str(prefix.resolve()):
        raise ValueError('Not an owned backlink-kit installation')
    return value


@contextmanager
def locked(prefix, shared=False, name='.install.lock'):
    with checked_path(prefix, prefix / name).open('a') as lock:
        try:
            fcntl.flock(lock, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Installation is busy. Stop backlink-kit start with Ctrl+C, then retry.') from None
        yield lock


def new_config(prefix, source):
    conf = prefix / 'config.json'
    if conf.exists():
        return
    write_json(conf, json.loads((source / 'config.example.json').read_text()))
    data = prefix / 'data'
    data.mkdir(mode=0o700)
    (data / 'directories.csv').write_text('domain,submit_url,status,scenario,fit_sites,dr,dr_date,last_verified,notes\n')
    (data / 'ledger.csv').write_text('record_id,source_domain,site,status,submitted_at,first_public_at,last_checked_at\n')
    (data / 'sites.md').write_text('# Your products\n')
    (data / 'kits').mkdir()
    write_json(data / 'kits/_profile.json', {'schema_version': 2, 'fields': {}, 'qa': {}, 'qa_overrides': {}})
    write_json(data / 'learned.json', {'labels': {}})


def verify_release(prefix, release):
    releases = checked_path(prefix, prefix / 'releases')
    checked_path(releases, release)
    if release.parent != releases:
        raise ValueError('Release is outside the installation')
    hashes = json.loads(checked_path(release, release / 'FILES.json').read_text())
    if not isinstance(hashes, dict) or 'bk.py' not in hashes:
        raise ValueError('Invalid release manifest')
    expected = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()[:24]
    if release.name != expected:
        raise ValueError('Release identity does not match its manifest')
    for name, digest in hashes.items():
        file = checked_path(release, release / name)
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise ValueError('Release file is missing or modified: ' + name)
    return release


def validate_candidate(release):
    # 启动器依赖管理入口及其distribution导入，不能只验证业务CLI。
    for entry in ('bk.py', 'tools/manage_install.py'):
        check = subprocess.run([sys.executable, str(release / entry), '--help'],
                               cwd=release, capture_output=True, timeout=30)
        if check.returncode:
            raise ValueError('Candidate entry validation failed: ' + entry)


def stage(prefix, source):
    files = payload(source)
    hashes = {name: hashlib.sha256(raw).hexdigest() for name, raw in sorted(files.items())}
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    releases = checked_path(prefix, prefix / 'releases')
    releases.mkdir(exist_ok=True)
    release = releases / digest[:24]
    if release.is_symlink():
        raise ValueError('Release directory must not be a symlink')
    if release.exists():
        verify_release(prefix, release)
        validate_candidate(release)
    if not release.exists():
        temp = Path(tempfile.mkdtemp(prefix='.stage-', dir=releases))
        try:
            for name, raw in files.items():
                target = temp / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
            write_json(temp / 'FILES.json', hashes)
            validate_candidate(temp)
            temp.rename(release)
        finally:
            if temp.exists():
                shutil.rmtree(temp)
    return release


def verify_extension(prefix, release):
    extension = checked_path(prefix, prefix / 'extension')
    hashes = json.loads((release / 'FILES.json').read_text())
    expected = {name.removeprefix('extension/'): digest for name, digest in hashes.items() if name.startswith('extension/')}
    actual = {str(path.relative_to(extension)): hashlib.sha256(checked_path(extension, path).read_bytes()).hexdigest()
              for path in extension.rglob('*') if path.is_file() or path.is_symlink()}
    if actual != expected:
        raise ValueError('Browser extension files are missing or modified; the installation is unchanged')


def switch(prefix, release):
    # 浏览器会固定软链的真实路径；独立目录确保重载后读取当前版本。
    extension = checked_path(prefix, prefix / 'extension')
    if extension.exists():
        verify_extension(prefix, (prefix / 'current').resolve(strict=True))
    temp = Path(tempfile.mkdtemp(prefix='.extension-', dir=prefix))
    link = prefix / ('.current-' + uuid.uuid4().hex)
    try:
        shutil.copytree(release / 'extension', temp / 'new')
        link.symlink_to(release.relative_to(prefix), target_is_directory=True)
        if extension.exists():
            extension.rename(temp / 'old')
        try:
            (temp / 'new').rename(extension)
            os.replace(link, prefix / 'current')
        except OSError:
            if extension.exists():
                shutil.rmtree(extension)
            if (temp / 'old').exists():
                (temp / 'old').rename(extension)
            raise
    finally:
        link.unlink(missing_ok=True)
        shutil.rmtree(temp)


def launcher_text(prefix, ident):
    python = shlex.quote(sys.executable)
    manager = shlex.quote(str(prefix / 'current/tools/manage_install.py'))
    root = shlex.quote(str(prefix))

    return (f'#!/bin/sh\n# backlink-kit managed: {ident}\n'
            f'export BK_HANDOFF_TOKEN_FILE={shlex.quote(str(prefix / "token"))}\n'
            f'case "${{1:-}}" in\n'
            f'  doctor|start|update|uninstall|rollback) action="$1"; shift; exec {python} {manager} "$action" --prefix {root} "$@" ;;\n'
            f'esac\nexec {python} {manager} run --prefix {root} -- "$@"\n')


def install(args):
    prefix = args.prefix.expanduser().absolute()
    if prefix.is_symlink() or prefix == Path('/') or prefix == Path.home():
        raise ValueError('Unsafe installation prefix')
    source = (args.source or SOURCE).expanduser().resolve()
    payload(source)
    provenance = {'source': str(source), 'repo': args.repo or origin(source), 'ref': args.ref or 'main'}
    if prefix.exists():
        meta = metadata(prefix)
    else:
        executable = args.bin_dir.expanduser().absolute() / APP
        if executable.exists() or executable.is_symlink():
            raise ValueError('Refusing to overwrite an unrelated command: ' + str(executable))
        prefix.mkdir(parents=True, mode=0o700)
        meta = {'app': APP, 'prefix': str(prefix.resolve()), 'id': uuid.uuid4().hex,
                'bin_dir': str(args.bin_dir.expanduser().absolute()), **provenance}
        write_json(prefix / '.installation.json', meta)
    with locked(prefix):
        executable = Path(meta['bin_dir']) / APP
        text = launcher_text(prefix, meta['id'])
        if executable.is_symlink() or (executable.exists() and f'# backlink-kit managed: {meta["id"]}\n' not in executable.read_text()):
            raise ValueError('Refusing to overwrite an unrelated command: ' + str(executable))
        release = stage(prefix, source)
        new_config(prefix, source)
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_text(text)
        executable.chmod(0o755)
        current = (prefix / 'current').resolve() if (prefix / 'current').exists() else None
        if current is not None and current != release:
            meta['previous'] = current.name
        switch(prefix, release)
        meta.update(provenance)
        write_json(prefix / '.installation.json', meta)
    print('Installed: ' + str(executable))
    print('Extension directory: ' + str(prefix / 'extension'))
    print('Next: ' + shlex.quote(str(executable)) + ' doctor; then start')


def origin(source):
    try:
        result = subprocess.run(['git', '-C', str(source), 'remote', 'get-url', 'origin'], capture_output=True, text=True)
    except FileNotFoundError:
        return None
    value = result.stdout.strip()
    return value if result.returncode == 0 and value.startswith('https://') else None


def activate_update(prefix, source, meta):
    current = (prefix / 'current').resolve(strict=True)
    if not current.is_relative_to(prefix / 'releases'):
        raise ValueError('Current release is outside the installation')
    release = stage(prefix, source)
    if release != current:
        meta['previous'] = current.name
    switch(prefix, release)
    write_json(prefix / '.installation.json', meta)
    print('Updated. Reload the unpacked browser extension, then start the service.')


def update(args):
    prefix = args.prefix.expanduser().absolute()
    meta = metadata(prefix)
    with locked(prefix):
        if args.source:
            source = args.source.expanduser().resolve()
            meta.update(source=str(source), repo=None)
            activate_update(prefix, source, meta)
            return
        repo = args.repo or meta.get('repo')
        if not repo:
            activate_update(prefix, Path(meta['source']), meta)
            return
        parts = urlsplit(repo)
        if parts.scheme not in ('https', 'file') or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError('Use a public HTTPS repository URL or an explicit local file:// repository')
        if parts.scheme == 'file' and (parts.netloc or not parts.path.startswith('/')):
            raise ValueError('Local repository must use file:///absolute/path')
        ref = args.ref or meta.get('ref', 'main')
        if not ref or ref.startswith('-'):
            raise ValueError('Invalid Git ref')
        with tempfile.TemporaryDirectory(prefix='.download-', dir=prefix) as temp:
            candidate = Path(temp) / 'source'
            result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--branch', ref,
                                     '--', repo, str(candidate)], capture_output=True, timeout=120)
            if result.returncode:
                raise ValueError('Repository download failed; the installed version is unchanged')
            meta.update(repo=repo, ref=ref)
            activate_update(prefix, candidate, meta)


def rollback(args):
    prefix = args.prefix.expanduser().absolute()
    meta = metadata(prefix)
    with locked(prefix):
        previous = meta.get('previous', '')
        if not previous or Path(previous).name != previous:
            raise ValueError('No previous release is available')
        release = prefix / 'releases' / previous
        verify_release(prefix, release)
        meta['previous'] = (prefix / 'current').resolve().name
        switch(prefix, release)
        write_json(prefix / '.installation.json', meta)
    print('Rolled back code; configuration and assets were not changed. Reload the extension.')


def doctor(args):
    prefix = args.prefix.expanduser().absolute()
    meta = metadata(prefix)
    verify_release(prefix, (prefix / 'current').resolve(strict=True))
    verify_extension(prefix, (prefix / 'current').resolve(strict=True))
    print(json.dumps({'installed': True, 'code_verified': True, 'python': sys.version.split()[0], 'prefix': str(prefix),
                      'config': str(prefix / 'config.json'), 'data': str(prefix / 'data'),
                      'extension': str(prefix / 'extension'), 'source': meta['source']}, indent=2))


def uninstall(args):
    prefix = args.prefix
    meta = metadata(prefix)
    if not args.yes:
        if not sys.stdin.isatty() or input('Remove backlink-kit code? Data is kept. Type uninstall: ') != 'uninstall':
            raise ValueError('Cancelled. For non-interactive removal, pass --yes.')
    with locked(prefix):
        executable = Path(meta['bin_dir']) / APP
        if executable.is_symlink() or (executable.exists() and f'# backlink-kit managed: {meta["id"]}\n' not in executable.read_text()):
            raise ValueError('The command was replaced by another installation; refusing to remove it')
        releases = prefix / 'releases'
        if releases.is_symlink() or ((prefix / 'current').exists() and not (prefix / 'current').is_symlink()):
            raise ValueError('Managed paths were replaced; refusing removal')
        if (prefix / 'extension').exists():
            verify_extension(prefix, (prefix / 'current').resolve(strict=True))
            shutil.rmtree(prefix / 'extension')
        executable.unlink(missing_ok=True)
        (prefix / 'current').unlink(missing_ok=True)
        if releases.exists():
            shutil.rmtree(releases)
    print('Uninstalled code and command. Configuration, token and assets remain in ' + str(prefix))
    print('Remove the unpacked extension manually in edge://extensions or chrome://extensions.')


def start(args):
    args.command = ['handoff', 'serve', '--port', str(args.port), '--token-file', str(args.prefix / 'token')]
    run(args)


def run(args):
    prefix = args.prefix
    metadata(prefix)
    serving = any(args.command[index:index + 2] == ['handoff', 'serve'] for index in range(len(args.command)))
    with locked(prefix, shared=True) as code_lock, (locked(prefix, name='.service.lock') if serving else nullcontext()) as service_lock:
        verify_release(prefix, (prefix / 'current').resolve(strict=True))
        # 所有CLI持有代码读锁；服务另持单实例锁，兼容旧serve入口且不阻断状态读回。
        for lock in (code_lock, service_lock):
            if lock is not None:
                os.set_inheritable(lock.fileno(), True)
        command = [str(prefix / 'current/bk.py'), '--config', str(prefix / 'config.json'), *args.command]
        os.execv(sys.executable, [sys.executable, *command])


def main(argv=None):
    if sys.version_info < (3, 11):
        raise SystemExit('Python 3.11+ is required')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'doctor', 'update', 'rollback', 'uninstall', 'start', 'run'))
    parser.add_argument('--prefix', type=Path, default=DEFAULT_PREFIX)
    parser.add_argument('--bin-dir', type=Path, default=DEFAULT_BIN)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--repo', help='Public HTTPS Git repository; file:// is supported for offline testing')
    parser.add_argument('--ref', help='Release tag or branch (default: main)')
    parser.add_argument('--yes', action='store_true', help='Confirm code removal; does not delete user data')
    parser.add_argument('--port', type=int, default=18780, help='Local service port; 0 selects a free port')
    argv = list(sys.argv[1:] if argv is None else argv)
    command = []
    if argv[:1] == ['run']:
        if '--' not in argv:
            parser.error('run requires -- before the CLI arguments')
        separator = argv.index('--')
        command, argv = argv[separator + 1:], argv[:separator]
    args = parser.parse_args(argv)
    args.command = command
    try:
        if args.prefix.expanduser().is_symlink():
            raise ValueError('Installation prefix must not be a symlink')
        args.prefix = args.prefix.expanduser().resolve()
        globals()[args.action](args)
        return 0
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print('Error: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
