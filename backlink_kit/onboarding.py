"""配套技能的本地资料入口：共享身份档案和产品素材包，不执行外部提交。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import tempfile
import zlib
from urllib.parse import urlsplit

from . import kits
from .core import atomic_json, config_lock, domain, load_config, protected


def save_identity(conf, incoming):
    if not isinstance(incoming, dict) or not isinstance(incoming.get('fields'), dict):
        raise ValueError('profile.fields 必须是对象')
    if any(not isinstance(value, str) for value in incoming['fields'].values()):
        raise ValueError('身份字段必须是字符串；未知或不适用填空字符串')
    current = kits.profile(conf)
    fields = dict.fromkeys(kits.PROFILE_KEYS, '')
    fields.update(current.get('fields') or {})
    fields.update(incoming['fields'])
    data = {**current, 'fields': fields}
    for key in ('qa', 'qa_overrides'):
        patch = incoming.get(key, {})
        if not isinstance(patch, dict) or any(not isinstance(value, str) for value in patch.values()):
            raise ValueError(key + ' 必须是字符串答案对象')
        data[key] = {**(current.get(key) or {}), **patch}
    return kits.save_profile(conf, data)


def checked_file(root, path):
    if not path.is_relative_to(root) or '..' in path.relative_to(root).parts:
        raise ValueError('素材路径越界')
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError('不接受软链接素材或目录')

    if not path.is_file():
        raise ValueError('素材文件不存在：' + path.name)
    return path


def import_product(config_path, bundle, *, apply=False, draft=False):
    config_path = Path(config_path).absolute()
    checked_file(config_path.parent, config_path)
    if not apply:
        return _import_product(config_path, bundle, draft=draft)
    with config_lock(config_path):
        return _import_product(config_path, bundle, apply=True, draft=draft)


def validate_png(path):
    if path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError('PNG 文件超过 50MB：' + path.name)
    raw = path.read_bytes()
    if len(raw) > 50 * 1024 * 1024 or raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('需要标准 PNG 图片：' + path.name)
    offset, pixels, palette, ended = 8, bytearray(), False, False
    while offset + 12 <= len(raw):
        length = int.from_bytes(raw[offset:offset + 4], 'big')
        kind = raw[offset + 4:offset + 8]
        end = offset + length + 12
        if end > len(raw) or zlib.crc32(raw[offset + 4:end - 4]) != int.from_bytes(raw[end - 4:end], 'big'):
            raise ValueError('PNG 截断或校验失败：' + path.name)
        if (offset == 8 and (kind != b'IHDR' or length != 13)) or (offset != 8 and kind == b'IHDR'):
            raise ValueError('PNG 头无效：' + path.name)
        if kind == b'IDAT':
            pixels.extend(raw[offset + 8:end - 4])
        palette = palette or kind == b'PLTE'
        offset = end
        if kind == b'IEND':
            ended = length == 0 and offset == len(raw)
            break
    if not ended:
        raise ValueError('PNG 文件不完整：' + path.name)
    width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', raw[16:29])
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
    depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
    if not width or not height or depth not in depths.get(color, ()) or compression or filtering or interlace or color == 3 and not palette:
        raise ValueError('请转换为非交错的标准 PNG：' + path.name)
    stride = (width * channels[color] * depth + 7) // 8 + 1
    expected = height * stride
    if expected > 64 * 1024 * 1024:
        raise ValueError('PNG 解码尺寸过大：' + path.name)
    try:
        decoder = zlib.decompressobj()
        decoded = decoder.decompress(pixels, expected + 1)
    except zlib.error:
        raise ValueError('PNG 像素数据损坏：' + path.name) from None
    if len(decoded) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or any(value > 4 for value in decoded[::stride]):
        raise ValueError('PNG 像素数据无效：' + path.name)
    return width, height, len(raw), hashlib.sha256(raw).hexdigest()


def _import_product(config_path, bundle, *, apply=False, draft=False):
    config_path = Path(config_path).absolute()
    bundle = Path(bundle).absolute()
    checked_file(config_path.parent, config_path)
    checked_file(bundle, bundle / 'kit.json')
    raw = json.loads((bundle / 'kit.json').read_text())
    if not isinstance(raw, dict) or not isinstance(raw.get('fields'), dict) or not isinstance(raw.get('assets'), list):
        raise ValueError('kit 必须包含 fields 对象和 assets 列表')
    if any(not isinstance(asset, dict) for asset in raw['assets']):
        raise ValueError('素材记录必须是对象')
    site = raw.get('site', '')
    if not isinstance(site, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', site):
        raise ValueError('site 必须是小写字母开头的站点键')
    if raw.get('schema_version') != kits.SCHEMA_VERSION:
        raise ValueError('需要 schema_version 2 资料包')
    original = config_path.read_bytes()
    conf = load_config(config_path)
    target = kits.kit_dir(conf, site)
    if site in conf['sites'] or target.exists() or target.is_symlink():
        raise ValueError('站点或目录已存在；不会覆盖现有产品')
    data: dict = kits.normalize(raw, site)
    url = kits.text_of(data['fields'].get('url'))
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError('产品首页需要不带凭据、查询或片段的 HTTP(S) 地址')
    data['fields']['domain'] = kits.variant(domain(url))
    data['fields']['url_bare'] = kits.variant(url.split('://', 1)[1].rstrip('/'))
    names, ids = set(), set()
    files = []
    for asset in data['assets']:
        name, ident, key = asset.get('file'), asset.get('id'), asset.get('key')
        if not isinstance(name, str) or not name or name in ('.', '..') or Path(name).name != name or '\\' in name:
            raise ValueError('素材 file 只允许文件名')
        if name in names or not isinstance(ident, str) or not ident or ident in ids or key not in kits.ASSET_RULES:
            raise ValueError('素材文件名、ID 必须唯一且角色有效')
        source = checked_file(bundle, bundle / 'assets' / name)
        if source.suffix.lower() != '.png' or 'image/png' not in kits.ASSET_RULES[key]['mimes']:
            raise ValueError('此入口导入标准 PNG 素材；其他媒体请在素材库上传')
        width, height, size, digest = validate_png(source)
        record: dict = kits.asset_record(source, key, ident=ident, alt=asset.get('alt', ''))
        record.update(w=width, h=height, bytes=size, sha256=digest)
        files.append((source, record))
        names.add(name)
        ids.add(ident)
    data['assets'] = [record for _, record in files]
    errors, warnings = kits.check(data, bundle)
    if errors and not draft:
        raise ValueError('素材包未通过检查：' + '；'.join(errors))
    report = {'site': site, 'applied': False, 'valid': not errors, 'errors': errors, 'warnings': warnings,
              'fields': sorted(data['fields']), 'assets': len(files), 'service_restart_required': False}
    if not apply:
        return report
    if protected(config_path) or protected(target):
        raise ValueError('真实数据只读；禁止导入')
    if any(item.is_symlink() for item in (target.parent, *target.parent.parents)):
        raise ValueError('资料库不能经过软链接')
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='.materials-', dir=target.parent) as temp:
        stage = Path(temp) / site
        (stage / 'assets').mkdir(parents=True, mode=0o700)
        for source, record in files:
            copied = stage / 'assets' / record['file']
            shutil.copyfile(source, copied)
            copied.chmod(0o600)
            if hashlib.sha256(copied.read_bytes()).hexdigest() != record['sha256']:
                raise ValueError('素材复制摘要不一致')
        atomic_json(stage / 'kit.json', data)
        if config_path.read_bytes() != original:
            raise ValueError('配置已变化，请重新预检')
        stage.rename(target)
        updated = json.loads(original)
        updated['sites'][site] = {'domain': domain(url), 'kit': site + '/kit.json'}
        try:
            if config_path.read_bytes() != original:
                raise ValueError('配置被外部修改，请在空闲时重新预检')
            atomic_json(config_path, updated)
        except (OSError, ValueError):
            # 只清理本次新建目录；既有产品永远不覆盖。
            shutil.rmtree(target)
            raise
    loaded, _ = kits.load(load_config(config_path), site, resolve_paths=False)
    if loaded != data:
        raise ValueError('导入后资料读回不一致；请核实，不要重复导入')
    return {**report, 'applied': True, 'service_restart_required': True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('profile-template')
    save = commands.add_parser('profile-save')
    save.add_argument('--file', type=Path, required=True)
    product = commands.add_parser('product-import')
    product.add_argument('--bundle', type=Path, required=True)
    product.add_argument('--apply', action='store_true')
    product.add_argument('--draft', action='store_true', help='显式保存缺项草稿，不称完整素材包')
    args = parser.parse_args(argv)
    try:
        if args.action == 'product-import':
            result = import_product(args.config, args.bundle, apply=args.apply, draft=args.draft)
        else:
            conf = load_config(args.config)
            if args.action == 'profile-template':
                current = kits.profile(conf)
                result = {**current, 'fields': {**dict.fromkeys(kits.PROFILE_KEYS, ''), **(current.get('fields') or {})}}
            else:
                saved = save_identity(conf, json.loads(args.file.read_text()))
                if kits.profile(conf) != saved:
                    raise ValueError('身份档案读回不一致；请核实，不要重复保存')
                result = {'saved': True, 'fields': sorted(saved['fields']),
                          'missing': [key for key in kits.PROFILE_KEYS if not saved['fields'].get(key)]}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
