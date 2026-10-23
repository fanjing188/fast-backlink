"""安装和公开源码打包共用白名单，禁止把工作区配置与业务资料复制给用户。"""
from pathlib import Path

ROOT_FILES = ('bk.py', 'package.json', 'config.example.json', 'README.md', 'SKILL.md',
              'LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'PRODUCT.md', 'DESIGN.md')
PUBLIC_DOCS = ('INSTALLATION.md', 'CAPABILITIES.md', 'OPEN_SOURCE.md', 'fast-backlink-cli.md')
PUBLIC_SKILLS = ('fast-backlink-init/SKILL.md', 'fast-backlink-product/SKILL.md')


def checked_path(root, path):
    """读取前逐级拒绝软链，不能只检查最终文件名。"""
    if not path.is_relative_to(root) or '..' in path.relative_to(root).parts:
        raise ValueError('Path is outside the owned root')
    current = path
    while current != root:
        if current.is_symlink():
            raise ValueError('Symlink not allowed: ' + str(current.relative_to(root)))
        current = current.parent
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Resolved path is outside the owned root')
    return path


def payload(source):
    source = Path(source).resolve()
    if not (source / 'bk.py').is_file() or not (source / 'config.example.json').is_file():
        raise ValueError('Source must contain bk.py and config.example.json')
    files = {}
    for name in ROOT_FILES:
        path = checked_path(source, source / name)
        if path.is_file():
            if path.is_symlink():
                raise ValueError('Symlink not allowed in source: ' + name)
            files[name] = path.read_bytes()
    for folder in ('backlink_kit', 'extension', 'rules', 'scripts', 'tools'):
        directory = checked_path(source, source / folder)
        for path in sorted(directory.rglob('*')):
            rel = path.relative_to(source)
            if any(part in ('__pycache__', 'e2e', 'tests', 'test-pages') for part in rel.parts):
                continue
            checked_path(source, path)
            if path.is_symlink():
                raise ValueError('Symlink not allowed in source: ' + str(rel))
            if not path.is_file() or path.name.startswith('.') or path.name.endswith(('.pyc', '.zip')):
                continue
            if str(rel) == 'rules/learned.json':
                continue
            files[rel.as_posix()] = path.read_bytes()
    for name in PUBLIC_DOCS:
        path = checked_path(source, source / 'docs' / name)
        if path.is_file():
            if path.is_symlink():
                raise ValueError('Symlink not allowed in docs')
            files['docs/' + name] = path.read_bytes()
    for name in PUBLIC_SKILLS:
        path = checked_path(source, source / 'skills' / name)
        if path.is_file():
            files['skills/' + name] = path.read_bytes()
    return files
