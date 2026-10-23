#!/usr/bin/env python3
"""清洁源码打包：与私有业务资产分离；缺许可时只允许本地验收候选。"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

from distribution import checked_path, payload

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = re.compile(r'/Users/[A-Za-z0-9._-]+/|[A-Za-z0-9._%+-]+@gmail\.com|'
                     r'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|'
                     r'ghp_[A-Za-z0-9]{32,}|sk-[A-Za-z0-9]{32,}|https?://[^/\s\x22\x27<>]+:[^/\s\x22\x27<>]+@')


def source_files(source):
    files = payload(source)
    for name in ('.gitignore', 'package-lock.json', '.github/workflows/quality.yml'):
        path = checked_path(source, source / name)
        if path.is_symlink():
            raise ValueError('Symlink not allowed: ' + name)
        if path.is_file():
            files[name] = path.read_bytes()
    for folder in ('tests', 'extension/tests', 'extension/e2e', 'extension/test-pages'):
        directory = checked_path(source, source / folder)
        for path in sorted(directory.rglob('*')):
            if '__pycache__' in path.parts or path.name.startswith('.'):
                continue
            checked_path(source, path)
            if path.is_symlink():
                raise ValueError('Symlink not allowed in developer fixtures')
            if path.is_file() and path.suffix in ('.py', '.cjs', '.mjs', '.js', '.json', '.html', '.csv', '.txt'):
                files[path.relative_to(source).as_posix()] = path.read_bytes()
    return files


def license_blockers(source):
    required = ('LICENSE', 'extension/vendor/fbl/LICENSE')
    missing = [name for name in required if not checked_path(source, source / name).is_file() or not (source / name).read_text().strip()]
    package = json.loads((source / 'package.json').read_text())
    if package.get('license') in (None, 'UNLICENSED'):
        missing.append('package.json license metadata')
    return missing


def validate(files):
    for name, raw in files.items():
        if Path(name).suffix in ('.png', '.ico'):
            continue
        text = raw.decode('utf-8')
        if PRIVATE.search(text):
            raise ValueError('Private path, contact or key-shaped value in: ' + name)
    # 文档只检查包内相对链接；外部URL和代码示例占位符不伪造联网验证。
    for name, raw in files.items():
        if not name.endswith('.md'):
            continue
        for link in re.findall(r'\]\(([^)\s]+)\)', raw.decode()):
            if ':' in link or link.startswith('#'):
                continue
            target = os.path.normpath(str(Path(name).parent / link.split('#')[0]))
            if target not in files:
                raise ValueError('Broken package documentation link: ' + name + ' -> ' + target)


def release_identity(source, version, files):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Release version must match major.minor.patch')
    try:
        def git(*args):
            return subprocess.check_output(['git', '-C', str(source), *args], stderr=subprocess.PIPE)
        if Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve() != source:
            raise ValueError('Release requires the committed repository root')
        if git('status', '--porcelain').strip():
            raise ValueError('Release requires a clean working tree')
        commit = git('rev-parse', 'HEAD').decode().strip()
        for name, raw in files.items():
            if git('show', f'{commit}:{name}') != raw:
                raise ValueError('Release payload differs from committed source: ' + name)
    except subprocess.CalledProcessError as error:
        raise ValueError('Release payload must come from committed Git source') from error
    package = json.loads(files['package.json'])
    lock = json.loads(files['package-lock.json'])
    extension = json.loads(files['extension/manifest.json'])
    module = ast.parse(files['backlink_kit/extension_api.py'].decode())
    runtime = next((ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == 'VERSION' for target in node.targets)), None)
    if any(value != version for value in [package['version'], lock['version'], lock['packages']['']['version'],
                                          extension['version'], runtime]):
        raise ValueError('Release version is inconsistent across runtime manifests')
    return {'version': version, 'source_commit': commit}


def build(source, output, local_candidate, release=None):
    source = source.resolve()
    if release and local_candidate:
        raise ValueError('Release and local candidate are mutually exclusive')
    blockers = license_blockers(source)
    if blockers and not local_candidate:
        raise ValueError('Publication blocked: license confirmation required: ' + ', '.join(blockers))
    files = source_files(source)
    validate(files)
    identity = release_identity(source, release, files) if release else {}
    manifest = {**identity, 'status': 'RELEASE_SOURCE' if release else 'NOT_FOR_PUBLICATION' if local_candidate else 'PUBLIC_SOURCE',
                'license_blockers': blockers,
                'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in sorted(files.items())}}
    files['SOURCE-MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, raw in sorted(files.items()):
                archive.writestr(name, raw)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None or any(hashlib.sha256(archive.read(name)).hexdigest() != digest
                                                for name, digest in manifest['files'].items()):
            raise ValueError('Archive verification failed; retain file for diagnosis')
    return {**identity, 'path': str(output.resolve()), 'status': manifest['status'], 'license_blockers': blockers,
            'files_including_manifest': len(files), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--local-candidate', action='store_true', help='Private evaluation only; not a redistribution license')
    mode.add_argument('--release', help='Build a version-matched release from clean committed source')
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.source, args.output, args.local_candidate, args.release), ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
