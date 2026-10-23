"""外链资产导出与换产品候选；仅本地读写，不执行外部提交。"""
import argparse
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import zipfile

from .core import load_config, read_csv, protected, today
from .sources import SourceStore, basic, new_source, submitted, walk_objects
from . import kits

PUBLIC = {'public', 'alive', 'live'}


def reuse(conf, site):
    """复用平台与经验，不复制旧产品资料，也不把旧资格当新产品批准。"""
    if not re.fullmatch(r'[a-z][a-z0-9-]*', site):
        raise ValueError('invalid_site')
    ledger = read_csv(conf['ledger'])[1]
    rows = []
    for record in SourceStore(conf['sources_dir']).rows():
        if submitted(record, site, ledger):
            continue
        history = record['history']
        public = [row for row in history if row.get('status', '').lower() in PUBLIC]
        accepted = [row for row in history if row.get('status', '').lower() in ('submitted', 'pending')]
        if not public and not accepted:
            continue
        rows.append(dict(source_domain=record['domain'], submit_urls=record['submit_urls'],
                         previous_sites=sorted({row['site'] for row in public + accepted if row.get('site')}),
                         historical_public=len(public), historical_accepted=len(accepted),
                         recipe_available=bool(record.get('recipe')),
                         checks=['产品匹配需确认', '费用、回链和条款需现场复核', '官方DR及日期需复核'],
                         admission=record['admission'].get('value', '待核实'),
                         dr=basic(record, 'dr'), dr_date=basic(record, 'dr_date')))
    return sorted(rows, key=lambda row: (-row['historical_public'], -row['historical_accepted'],
                                        -row['recipe_available'], row['source_domain']))


def export(conf, output):
    target = Path(output).expanduser()
    if protected(target):
        raise ValueError('测试禁止写入真实资产目录')
    files = {}
    missing = []
    library = SourceStore(conf['sources_dir'])
    with library.lock():
        for row in library.rows():
            name = new_source(row['domain'])['domain']
            files['sources/' + name + '.json'] = json.dumps(row, ensure_ascii=False, indent=2).encode()
        for key in ('directories', 'ledger'):
            path = Path(conf[key])
            if path.exists():
                files[key + '.csv'] = path.read_bytes()
        for path in sorted(Path(conf['handoff_dir']).glob('*.json')):
            if re.fullmatch('[a-f0-9]{32}', path.stem):
                files['handoff/' + path.name] = path.read_bytes()
    for site in conf['sites']:
        kit, _ = kits.load(conf, site)
        kit = deepcopy(kit)
        for index, asset in enumerate(kit['assets']):
            try:
                _, path = kits.resolve_asset(conf, site, str(index))
                raw = path.read_bytes()
                name = hashlib.sha256(raw).hexdigest()[:16] + '-' + path.name
                files[f'kits/{site}/assets/{name}'] = raw
                asset['file'] = name
                asset['sha256'] = hashlib.sha256(raw).hexdigest()
                asset.pop('source', None)
            except (ValueError, OSError):
                missing.append(f'kits/{site}/asset/{asset.get("id", index)}')
        files[f'kits/{site}/kit.json'] = json.dumps(kit, ensure_ascii=False, indent=2).encode()
    files['kits/_profile.json'] = json.dumps(kits.profile(conf), ensure_ascii=False, indent=2).encode()
    # 只打包资料中已引用、且位于项目报告目录内的证据；不读取任意本机路径或配置。
    workspace = Path(conf['ledger']).resolve().parents[2]
    evidence_map = {}
    refs = set()
    for name, raw in list(files.items()):
        if not name.endswith('.json') or name.startswith('kits/'):
            continue
        for node in walk_objects(json.loads(raw)):
            for key in ('path', 'receipt'):
                value = node.get(key)
                if isinstance(value, str) and (value.startswith('/') or value.startswith('reports/')):
                    refs.add(value.split('#')[0])
    for ref in sorted(refs):
        path = Path(ref) if Path(ref).is_absolute() else workspace / ref
        path = path.resolve()
        if not path.is_relative_to(workspace) or 'reports' not in path.relative_to(workspace).parts:
            missing.append(ref)
            continue
        if not path.is_file():
            missing.append(ref)
            continue
        name = 'evidence/' + hashlib.sha256(str(path).encode()).hexdigest()[:16] + '-' + path.name
        files[name] = path.read_bytes()
        evidence_map[ref] = name
    manifest = dict(schema_version=1, created_at=str(today()), sources=sum(name.startswith('sources/') for name in files),
                    evidence_files=evidence_map, missing_files=sorted(set(missing)),
                    files={name: hashlib.sha256(data).hexdigest() for name, data in files.items()})
    target.parent.mkdir(parents=True, exist_ok=True)
    # 不覆盖既有备份；失败也保留文件供诊断，不删除用户数据。
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
            archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None:
            raise ValueError('导出CRC校验失败，请保留文件诊断')
    return dict(path=str(target.resolve()), sources=manifest['sources'], files=len(files),
                missing_files=len(manifest['missing_files']),
                sha256=hashlib.sha256(target.read_bytes()).hexdigest(), bytes=target.stat().st_size)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('export').add_argument('--output', required=True)
    sub.add_parser('reuse').add_argument('--site', required=True)
    args = parser.parse_args(argv)
    try:
        conf = load_config(args.config)
        result = export(conf, args.output) if args.action == 'export' else reuse(conf, args.site)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
