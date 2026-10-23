import os
from pathlib import Path
import tempfile
os.environ['BK_PROTECT_REAL'] = '1'
# 所有测试与派生脚本使用私有临时根；不把探针或业务替身落到系统临时目录。
root = Path(os.environ.get('BK_TEST_TMPDIR', Path.home() / '.cache/backlink-kit/tests')).expanduser()
root.mkdir(parents=True, exist_ok=True)
os.environ['TMPDIR'] = str(root)
os.environ['BK_HANDOFF_TOKEN_FILE'] = str(root / 'test-token-only')
tempfile.tempdir = str(root)
