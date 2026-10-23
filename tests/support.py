"""可公开的合成资料夹具；不读取作者的配置、真实产品文案或媒体。"""
import atexit
import json
from pathlib import Path
import struct
import tempfile
import zlib

from backlink_kit import core

_TEMP = []


def temporary_root():
    temp = tempfile.TemporaryDirectory(prefix='backlink-fixture-')
    _TEMP.append(temp)
    return Path(temp.name)


def cleanup():
    for temp in reversed(_TEMP):
        temp.cleanup()


atexit.register(cleanup)
_ASSETS = None


def legacy_kit() -> dict:
    global _ASSETS
    if _ASSETS is None:
        root = temporary_root()
        _ASSETS = []
        for key, width, height in (('logo', 512, 512), ('screenshot', 1280, 800)):
            path = root / (key + '.png')
            def chunk(kind, raw):
                return struct.pack('>I', len(raw)) + kind + raw + struct.pack('>I', zlib.crc32(kind + raw) & 0xffffffff)
            pixels = (b'\x00' + b'\x31\x5f\xc7' * width) * height
            raw = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                   + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))
            path.write_bytes(raw)
            _ASSETS.append(dict(key=key, path=str(path), width=width, height=height))
    fields = dict(name='ProbeKits', url='https://probekits.com/', tagline='Synthetic browser testing fixture',
                  short_description='A synthetic product description for offline form-matching regression tests only.',
                  description='This is synthetic test content for form matching and restoration. It is not a statement about a live product. '
                              'It contains enough text to exercise description length selection without using business assets.',
                  category='Hardware Testing', tags='keyboard, mouse', pricing='Free', email='maker@example.test',
                  signature='Example Maker')
    return dict(source='Synthetic regression fixture, not live product facts',
                fields={key: {'value': value, 'length': len(value)} for key, value in fields.items()},
                images=[dict(image) for image in _ASSETS])


def fixture_config() -> dict:
    root = temporary_root()
    conf = json.loads((core.ROOT / 'config.example.json').read_text())
    conf['sites'] = {site: {'domain': site + '.com', 'kit': site + '.json'}
                     for site in ('probekits', 'raumlens', 'lessonprism', 'gematria')}
    path = root / 'config.json'
    core.atomic_json(path, conf)
    conf = core.load_config(path)
    for key in ('kits_dir', 'sources_dir', 'handoff_dir', 'runs_dir', 'snapshots_dir', 'logs_dir', 'settings_dir', 'stage_dir'):
        Path(conf[key]).mkdir(parents=True, exist_ok=True)
    core.write_csv(conf['directories'], ['domain', 'submit_url', 'status', 'fit_sites', 'dr', 'dr_date', 'notes'], [])
    core.write_csv(conf['ledger'], ['record_id', 'source_domain', 'site', 'status'], [])
    for site in conf['sites']:
        data = legacy_kit()
        core.atomic_json(Path(conf['kits_dir']) / (site + '.json'), data)
    return conf
