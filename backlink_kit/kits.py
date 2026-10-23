"""资料包 v2：每站一个目录（kit.json + assets/），是素材的唯一数据源。

v1 是单文件 JSON（`kits/<site>.json`，字段带 value/length，图片只有 path）。
v2 增加：描述分档、多语言、标签列表、分类候选、媒体元数据、问答覆盖、链接字段。
迁移只做结构提升和资源复制，不改写任何文案内容，也不删旧文件。
"""
from __future__ import annotations
import json
import mimetypes
import re
import shutil
from pathlib import Path

from .core import atomic_json, protected  # noqa: F401  (protected 供上层复用)

SCHEMA_VERSION = 2

# 文本字段全集：A 基本信息、B 链接、D 长文本模板（plan §1.2）。
TEXT_KEYS = (
    'name', 'url', 'url_bare', 'domain', 'tagline', 'short_description', 'description',
    'features', 'use_cases', 'audience', 'category', 'tags', 'pricing_model', 'pricing_text',
    'pricing', 'price_from', 'launch_date', 'founded_year', 'platforms', 'languages',
    'alternatives', 'open_source', 'github_url', 'license', 'email', 'signature',
    'pricing_url', 'docs_url', 'blog_url', 'changelog_url', 'privacy_url', 'terms_url',
    'rss_url', 'sitemap_url', 'demo_url', 'video_url',
    'maker_story', 'launch_comment', 'pitch', 'press_boilerplate', 'faq', 'changelog_latest',
)
LIST_KEYS = ('features', 'use_cases', 'tags', 'platforms', 'languages', 'alternatives', 'faq')
# 必须存在的字段与长度上限；缺失进“缺项清单”，但不阻塞使用。
REQUIRED_KEYS = ('name', 'url', 'tagline', 'description', 'category')
# v1 叫 pricing，v2 拆成 pricing_model；两者有其一即可。
REQUIRED_ALIASES = {'pricing_model': ('pricing_model', 'pricing')}
VARIANT_LIMITS = (40, 60, 80, 100, 160, 250, 500, 1000, 2000)
# 按分档长度放置文案时，长的字段可提供短字段的快照。
VARIANT_SOURCE = ('tagline', 'short_description', 'description')
ASSET_KEYS = ('logo', 'icon', 'favicon', 'cover', 'screenshot', 'demo_gif', 'demo_video', 'maker_avatar')
# 计划里图像类的 accept 与媒体角色对应；视频类素材暂不制作，字段留位（plan §1.2C）。
ASSET_RULES = {
    'logo': dict(mimes=('image/png', 'image/jpeg', 'image/svg+xml'), hint='512×512 透明底 PNG'),
    'icon': dict(mimes=('image/png',), hint='32/64 px'),
    'favicon': dict(mimes=('image/png', 'image/x-icon'), hint='32/64 px'),
    'cover': dict(mimes=('image/png', 'image/jpeg'), hint='1200×630'),
    'screenshot': dict(mimes=('image/png', 'image/jpeg'), hint='1280×800'),
    'demo_gif': dict(mimes=('image/gif',), hint='≤5MB'),
    'demo_video': dict(mimes=('video/mp4',), hint='16:9，≤50MB'),
    'maker_avatar': dict(mimes=('image/png', 'image/jpeg'), hint='400×400'),
}
VIDEO_KEYS = ('demo_video', 'demo_gif')
PROFILE_FILE = '_profile.json'

PROFILE_KEYS = (
    'maker_name', 'first_name', 'last_name', 'role', 'email', 'company', 'country', 'city',
    'twitter', 'twitter_url', 'linkedin', 'github', 'producthunt', 'youtube', 'discord',
    'indiehackers', 'website_personal', 'maker_avatar',
)
# 身份、团队与发现渠道都是事实，只使用本人保存的答案，不提供猜测默认值。
QA_DEFAULTS = {}


def kit_dir(conf, site):
    return Path(conf['kits_dir']) / site


def legacy_path(conf, site):
    """v1 单文件资料包的位置：先在 kits_dir，再回退仓库内的 kits/。"""
    entry = conf['sites'][site]
    candidates = [Path(conf['kits_dir']) / entry['kit'], Path(conf['kits_dir']) / f'{site}.json',
                  Path(__file__).resolve().parents[1] / 'kits' / f'{site}.json']
    for path in candidates:
        if path.suffix == '.json' and path.exists():
            return path
    return candidates[0]


def profile_path(conf):
    return Path(conf['kits_dir']) / PROFILE_FILE


def empty_kit(site):
    return dict(schema_version=SCHEMA_VERSION, site=site, fields={}, assets=[], qa_overrides={})


def variant(value):
    """把纯文本包装成带分档的字段；已有 variants 的字段用 wrap_field 补充。"""
    return {'value': value, 'variants': {str(len(value)): value}, 'i18n': {}}


def wrap_field(value):
    if isinstance(value, dict):
        field = dict(value)
        field.setdefault('i18n', {})
        variants = dict(field.get('variants') or {})
        text = field.get('value')
        if text:
            variants.setdefault(str(len(text)), text)
        if variants:
            field['variants'] = variants
        return field
    if isinstance(value, list):
        return {'list': list(value), 'value': ', '.join(str(x) for x in value)}
    return variant(str(value))


def text_of(field):
    if isinstance(field, str):
        return field
    if not isinstance(field, dict):
        return ''
    if field.get('value') is not None:
        return str(field['value'])
    variants = field.get('variants') or {}
    if variants:
        return variants[max(variants, key=lambda k: int(k))] if all(str(k).isdigit() for k in variants) else next(iter(variants.values()))
    if field.get('list'):
        return ', '.join(str(x) for x in field['list'])
    return ''


def pick_variant(field, limit=None, minimum=None, default=2000):
    """按 maxlength/提示选最长且不超上限的分档；都没有时不截断（沿用 0.1.x 规则）。"""
    if isinstance(field, str):
        field = variant(field)
    if not isinstance(field, dict):
        return None
    texts = []
    variants = field.get('variants') or {}
    if variants:
        texts.extend(str(v) for v in variants.values())
    for key in ('value', 'list'):
        if key == 'list' and field.get('list'):
            texts.append(', '.join(str(x) for x in field['list']))
        elif field.get(key):
            texts.append(str(field[key]))
    unique = sorted({t for t in texts if t}, key=len)
    if limit is not None and limit >= 0:
        fits = [t for t in unique if len(t) <= limit]
        if fits:
            return fits[-1]
        return None
    if minimum:
        fits = [t for t in unique if len(t) >= minimum]
        if fits:
            return fits[0]
    return unique[-1] if unique else None


def from_v1(site, legacy):
    """v1 单文件结构提升为 v2；旧 fields.<key>.value 原样保留。"""
    kit = empty_kit(site)
    for key, field in (legacy.get('fields') or {}).items():
        if not isinstance(field, dict):
            kit['fields'][key] = wrap_field(field)
            continue
        value = field.get('value')
        if key in LIST_KEYS and isinstance(value, str):
            kit['fields'][key] = {'list': [x.strip() for x in re.split(r'[,，;；\n]', value) if x.strip()], 'value': value}
        elif key == 'category' and isinstance(value, str) and '/' in value:
            parts = [x.strip() for x in value.split('/') if x.strip()]
            kit['fields'][key] = {'value': parts[0], 'alternates': parts[1:], 'variants': {str(len(value)): value}, 'i18n': {}}
        else:
            kit['fields'][key] = wrap_field(field)
    for image in legacy.get('images') or []:
        path = Path(image['path'])
        kit['assets'].append(dict(id=path.stem, key=image.get('key', 'screenshot'), file=path.name,
                                  source=str(path), w=image.get('width'), h=image.get('height'),
                                  mime=mimetypes.guess_type(path.name)[0], bytes=None, alt=f"{legacy.get('fields',{}).get('name',{}).get('value','')} {image.get('key','')}".strip()))
    return kit


def normalize(kit, site=None):
    """读取或外部导入的数据统一补齐结构；不判断内容对错。"""
    result = empty_kit(kit.get('site') or site or '')
    result['schema_version'] = SCHEMA_VERSION
    for key, field in (kit.get('fields') or {}).items():
        result['fields'][key] = wrap_field(field)
    assets = []
    for index, asset in enumerate(kit.get('assets') or []):
        item = dict(asset)
        item.setdefault('id', Path(str(item.get('file', 'asset-' + str(index)))).stem or 'asset-' + str(index))
        item.setdefault('key', 'screenshot')
        item.setdefault('file', Path(str(item.get('source', item['id']))).name)
        item.setdefault('mime', mimetypes.guess_type(str(item['file']))[0])
        assets.append(item)
    result['assets'] = assets
    result['qa_overrides'] = dict(kit.get('qa_overrides') or {})
    for key in ('source',):
        if kit.get(key):
            result[key] = kit[key]
    return result


def load(conf, site, *, resolve_paths=True) -> tuple[dict, Path]:
    """读 v2 目录；不存在时回退 v1 单文件（迁移前的只读兼容）。"""
    directory = kit_dir(conf, site)
    path = directory / 'kit.json'
    if path.exists():
        kit = normalize(json.loads(path.read_text()), site)
        return (_with_paths(kit, directory) if resolve_paths else kit), directory
    legacy = legacy_path(conf, site)
    if legacy.exists():
        kit = from_v1(site, json.loads(legacy.read_text()))
        return (_with_paths(kit, directory) if resolve_paths else kit), directory
    raise ValueError(f'资料包不存在：{site}（先 bk.py kits migrate）')


def _with_paths(kit, directory):
    """补上素材的绝对路径和 v1 兼容的 images 视图；旧脚本不必改。"""
    images = []
    for asset in kit['assets']:
        resolved = directory / 'assets' / str(asset.get('file', ''))
        if not resolved.exists() and asset.get('source'):
            resolved = Path(asset['source'])
        asset['path'] = str(resolved)
        images.append({'key': asset.get('key'), 'path': str(resolved),
                       'width': asset.get('w'), 'height': asset.get('h')})
    kit['images'] = images
    return kit


def resolve_asset(conf, site, ident):
    """按素材编号或 id 找到实际文件；扩展只拿编号，不拿路径。"""
    kit, directory = load(conf, site)
    assets = kit['assets']
    found = None
    if str(ident).isdecimal() and int(ident) < len(assets):
        found = assets[int(ident)]
    else:
        found = next((a for a in assets if a.get('id') == ident), None)
    if not found:
        raise ValueError('file_not_registered')
    path = directory / 'assets' / str(found.get('file'))
    if not path.exists() and found.get('source'):
        path = Path(found['source'])
    if not path.exists():
        raise ValueError('file_missing')
    return found, path


def profile(conf):
    path = profile_path(conf)
    if not path.exists():
        return {'schema_version': SCHEMA_VERSION, 'fields': {}, 'qa': dict(QA_DEFAULTS),
                'qa_overrides': {}, 'created_at': None}
    return json.loads(path.read_text())


def today_profile(conf):
    """首次使用时建立全局身份档案骨架；已存在则原样返回。"""
    path = profile_path(conf)
    if path.exists():
        return json.loads(path.read_text())
    data = {'schema_version': SCHEMA_VERSION, 'fields': {}, 'qa': dict(QA_DEFAULTS), 'qa_overrides': {}}
    save_profile(conf, data)
    return data


def save_profile(conf, data):
    data = dict(data)
    data['schema_version'] = SCHEMA_VERSION
    data.setdefault('qa', dict(QA_DEFAULTS))
    atomic_json(profile_path(conf), data)
    return data


def save(conf, site, kit):
    kit = normalize(kit, site)
    kit['site'] = site
    directory = kit_dir(conf, site)
    directory.mkdir(parents=True, exist_ok=True)
    atomic_json(directory / 'kit.json', kit)
    return directory / 'kit.json'


def asset_record(path, key, ident=None, alt='', source=None):
    from .media import image_size
    size = image_size(path)
    record = dict(id=ident or Path(path).stem, key=key, file=Path(path).name,
                  mime=mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
                  bytes=path.stat().st_size, alt=alt)
    if size:
        record.update(w=size[0], h=size[1])
    if source:
        record['source'] = str(source)
    return record


def migrate(conf, apply=False):
    """把 v1 单文件资料包迁到 v2 目录；--dry-run 只报告将要发生的事。"""
    report = {'kits': [], 'profile': None}
    for site in conf['sites']:
        directory = kit_dir(conf, site)
        target = directory / 'kit.json'
        legacy = legacy_path(conf, site)
        entry = {'site': site, 'target': str(target), 'assets': 0, 'fields': 0, 'status': ''}
        if target.exists():
            entry['status'] = '已经是 v2，跳过'
            report['kits'].append(entry)
            continue
        if not legacy.exists():
            entry['status'] = '找不到 v1 资料包'
            report['kits'].append(entry)
            continue
        kit = from_v1(site, json.loads(legacy.read_text()))
        entry['fields'] = len(kit['fields'])
        if apply:
            directory.mkdir(parents=True, exist_ok=True)
            assets_dir = directory / 'assets'
            assets_dir.mkdir(parents=True, exist_ok=True)
            for asset in kit['assets']:
                source = Path(asset.pop('source', '') or '')
                asset.pop('bytes', None)
                if source.exists():
                    shutil.copy2(source, assets_dir / source.name)
                    refreshed = asset_record(assets_dir / source.name, asset['key'], ident=asset['id'], alt=asset.get('alt', ''))
                    refreshed['source'] = str(source)
                    asset.update(refreshed)
            entry['assets'] = len(kit['assets'])
            atomic_json(target, kit)
            entry['status'] = '已迁移'
        else:
            entry['assets'] = len(kit['assets'])
            entry['status'] = '待迁移'
        report['kits'].append(entry)
    profile_file = profile_path(conf)
    report['profile'] = str(profile_file)
    if apply and not profile_file.exists():
        save_profile(conf, {'schema_version': SCHEMA_VERSION, 'fields': {}, 'qa': dict(QA_DEFAULTS), 'qa_overrides': {}})
    return report


def check(kit, directory=None, profile_data=None):
    """v2 校验：必填项、分档齐全度、超长、文件存在与尺寸、视频缺素材提示。"""
    errors, warnings = [], []
    fields = kit.get('fields') or {}
    for key in REQUIRED_KEYS:
        if not text_of(fields.get(key)):
            errors.append(f'{key}: 缺失')
    for key, names in REQUIRED_ALIASES.items():
        if not any(text_of(fields.get(name)) for name in names):
            errors.append(f'{key}: 缺失')
    for key in TEXT_KEYS:
        field = fields.get(key)
        if not isinstance(field, dict):
            continue
        text = field.get('value')
        for limit in (40, 60, 80, 100, 160, 250, 500, 1000, 2000):
            value = (field.get('variants') or {}).get(str(limit))
            if value and len(value) > limit:
                errors.append(f'{key}: 分档 {limit} 的文案实际 {len(value)} 字符')
        if key in VARIANT_SOURCE and text and len(text) > 2000:
            warnings.append(f'{key}: 主值超过 2000 字符，请用分档')
    if not text_of(fields.get('tags')):
        warnings.append('tags: 缺失，标签类字段将无法填写')
    for key in ASSET_RULES:
        if not any(a.get('key') == key for a in kit.get('assets') or []):
            if key in VIDEO_KEYS:
                # 视频按计划不制作，缺素材不报错，只提示。
                warnings.append(f'{key}: 缺素材（字段留位，交人处理）')
            elif key in ('logo', 'screenshot'):
                errors.append(f'{key}: 缺失')
            else:
                warnings.append(f'{key}: 缺失')
    for asset in kit.get('assets') or []:
        path = Path(asset.get('file', ''))
        resolved = (directory / 'assets' / path.name) if directory else path
        if not resolved.exists() and asset.get('source'):
            resolved = Path(asset['source'])
        if not resolved.exists():
            errors.append(f"assets/{asset.get('file')}: 文件不存在")
            continue
        rules = ASSET_RULES.get(asset.get('key'), {})
        mime = asset.get('mime') or mimetypes.guess_type(resolved.name)[0]
        if rules.get('mimes') and mime not in rules['mimes']:
            errors.append(f"{asset.get('file')}: 格式 {mime} 不符合 {rules['hint']}")
        if asset.get('bytes') and asset['bytes'] != resolved.stat().st_size:
            warnings.append(f"{asset.get('file')}: 大小与记录不一致")
    if not (kit.get('qa_overrides') or {}):
        warnings.append('qa_overrides: 未定制，仅使用本人保存的共享问答；未知答案留空交人')
    if profile_data is not None and not (profile_data.get('fields') or {}):
        warnings.append('全局身份档案为空：提交人姓名/邮箱类字段会留空')
    return errors, warnings


def kit_summary(conf, site):
    kit, directory = load(conf, site)
    errors, warnings = check(kit, directory, profile(conf))
    return {'site': site, 'directory': str(directory), 'schema_version': kit.get('schema_version'),
            'fields': sorted(kit['fields']), 'assets': len(kit['assets']), 'errors': errors, 'warnings': warnings}
