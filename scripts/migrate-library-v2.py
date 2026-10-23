#!/usr/bin/env python3
"""迁移规范字段；真实数据验收仅使用 --dry-run。"""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backlink_kit import core, library_v2
from backlink_kit.sources import SourceStore

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config', type=Path)
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument('--dry-run', action='store_true')
mode.add_argument('--apply', action='store_true')
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
conf = core.load_config(args.config)
if args.apply:
    with SourceStore(conf['sources_dir']).lock():
        result = library_v2.migration(conf, apply=True)
        SourceStore(conf['sources_dir']).index()
else:
    result = library_v2.migration(conf)
core.atomic_json(args.report, result)
print(json.dumps(result, ensure_ascii=False, indent=2))
