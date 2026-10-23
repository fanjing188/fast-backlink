#!/bin/sh
# 面向用户的一键安装入口；下载校验和运行时准备完成后复用现有安装器。
set -eu
umask 077

PREFIX=${BACKLINK_KIT_PREFIX:-"$HOME/.local/share/backlink-kit"}
BIN_DIR=${BACKLINK_KIT_BIN_DIR:-"$HOME/.local/bin"}
SOURCE=
VERSION=
MANAGED=0
OPEN_BROWSER=1
EXPLICIT_PREFIX=0
REPO=https://github.com/fanjing188/fast-backlink

fail() { printf '安装失败：%s\n' "$*" >&2; exit 2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix|--bin-dir|--source|--version)
      [ "$#" -ge 2 ] || fail "$1 缺少参数"
      case "$1" in
        --prefix) PREFIX=$2; EXPLICIT_PREFIX=1 ;; --bin-dir) BIN_DIR=$2 ;;
        --source) SOURCE=$2 ;; --version) VERSION=$2 ;;
      esac
      shift 2 ;;
    --managed-python) MANAGED=1; shift ;;
    --no-open) OPEN_BROWSER=0; shift ;;
    --help)
      printf '%s\n' '用法：sh scripts/setup.sh [--prefix 安装目录] [--bin-dir 命令目录]' \
        '  --source 目录      安装本地源码；在项目目录执行时自动识别' \
        '  --version v1.0.2   安装指定正式版本；在线安装默认使用最新 Release' \
        '  --managed-python  使用独立的 Python 运行时' '  --no-open         不打开浏览器扩展管理页'
      exit 0 ;;
    *) fail "未知参数 $1" ;;
  esac
done
[ "$(uname -s)" = Darwin ] || fail '目前一键安装仅支持 macOS。'
[ -z "$SOURCE" ] || [ -z "$VERSION" ] || fail '--source 与 --version 不能同时使用。'
if [ -z "$SOURCE$VERSION" ] && [ -f "$0" ]; then
  HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
  if [ -f "$HERE/bk.py" ]; then SOURCE=$HERE; fi
fi
if [ -n "$SOURCE" ]; then
  SOURCE=$(CDPATH= cd -- "$SOURCE" && pwd)
  [ -f "$SOURCE/tools/manage_install.py" ] || fail '指定目录不是 Fast-Backlink 源码。'
fi
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/fast-backlink-setup.XXXXXX")
trap 'rm -rf "$TEMP"' 0
trap 'exit 130' 1 2 3 15
download() {
  curl -fLsS --retry 2 --connect-timeout 15 --max-time 180 "$1" -o "$2" || fail "下载失败：$1。请检查网络后重试。"
}
if [ "$EXPLICIT_PREFIX" = 0 ] && [ -f "$BIN_DIR/backlink-kit" ] && grep -q '^# backlink-kit managed: ' "$BIN_DIR/backlink-kit"; then
  "$BIN_DIR/backlink-kit" doctor >"$TEMP/existing.json" || fail '已有安装检查失败，请先运行 backlink-kit doctor 核实。'
  PREFIX=$(/usr/bin/plutil -extract prefix raw -o - "$TEMP/existing.json")
fi
[ -n "$PREFIX" ] && [ -n "$BIN_DIR" ] || fail '安装目录和命令目录不能为空。'
case "$PREFIX" in /*) ;; *) PREFIX=$PWD/$PREFIX ;; esac
case "$BIN_DIR" in /*) ;; *) BIN_DIR=$PWD/$BIN_DIR ;; esac
[ "$PREFIX" != / ] && [ "$PREFIX" != "$HOME" ] && [ ! -L "$PREFIX" ] || fail '安装目录不安全。'
if [ -e "$PREFIX" ] && [ ! -f "$PREFIX/.installation.json" ]; then fail '目录已存在且不是受管安装，请使用新的安装目录。'; fi

PYTHON_BIN=
if [ "$MANAGED" = 0 ]; then
  CANDIDATE=$(command -v "${PYTHON:-python3}" || true)
  # 避免在未安装开发工具的新 Mac 上触发系统 Python 的安装弹窗。
  if [ "$CANDIDATE" = /usr/bin/python3 ] && ! /usr/bin/xcode-select -p >/dev/null 2>&1; then CANDIDATE=; fi
  if [ -n "$CANDIDATE" ] && "$CANDIDATE" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
    PYTHON_BIN=$CANDIDATE
  elif [ -n "${PYTHON:-}" ]; then fail 'PYTHON 必须指向可用的 Python 3.11+。'; fi
fi
if [ -z "$PYTHON_BIN" ]; then
  printf '%s\n' '正在准备独立 Python 3.11，不修改系统 Python 或 shell 配置…'
  RUNTIME=${PREFIX}-runtime
  if [ -e "$RUNTIME" ] || [ -L "$RUNTIME" ]; then
    [ ! -L "$RUNTIME" ] && [ -f "$RUNTIME/.backlink-kit-runtime" ] || fail '运行时目录已存在，无法确认归属。'
  else
    mkdir -p "$RUNTIME"
    printf '%s\n' 'backlink-kit' >"$RUNTIME/.backlink-kit-runtime"
  fi
  if [ ! -x "$RUNTIME/uv/uv" ]; then
    download https://astral.sh/uv/install.sh "$TEMP/install-uv.sh"
    UV_UNMANAGED_INSTALL="$RUNTIME/uv" sh "$TEMP/install-uv.sh"
  fi
  export UV_PYTHON_INSTALL_DIR="$RUNTIME/python" UV_CACHE_DIR="$RUNTIME/cache"
  "$RUNTIME/uv/uv" python install --no-bin 3.11
  PYTHON_BIN=$("$RUNTIME/uv/uv" python find --managed-python --no-python-downloads 3.11)
fi
"$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' || fail 'Python 运行时不可用。'

if [ -z "$SOURCE" ]; then
  if [ -z "$VERSION" ]; then
    download https://api.github.com/repos/fanjing188/fast-backlink/releases/latest "$TEMP/release.json"
    VERSION=$("$PYTHON_BIN" -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag_name"])' "$TEMP/release.json")
  fi
  "$PYTHON_BIN" - "$VERSION" <<'PY'
import re, sys
version = sys.argv[1]
if not re.fullmatch(r'v\d+\.\d+\.\d+', version):
    raise SystemExit('正式版本格式无效，例如 v1.0.2。')
if tuple(map(int, version[1:].split('.'))) < (1, 0, 2):
    raise SystemExit('一键安装需要 1.0.2 或更新的正式 Release。')
PY
  ARCHIVE=fast-backlink-${VERSION#v}.zip
  printf '正在下载并校验 Fast-Backlink %s…\n' "$VERSION"
  download "$REPO/releases/download/$VERSION/$ARCHIVE" "$TEMP/$ARCHIVE"
  download "$REPO/releases/download/$VERSION/SHA256SUMS" "$TEMP/SHA256SUMS"
  SOURCE=$TEMP/source
  "$PYTHON_BIN" - "$TEMP/$ARCHIVE" "$TEMP/SHA256SUMS" "$SOURCE" "$VERSION" <<'PY'
import hashlib, json, pathlib, re, stat, sys, zipfile
archive, sums, target, version = sys.argv[1:]
archive, target = pathlib.Path(archive), pathlib.Path(target)
matches = [line.split()[0] for line in pathlib.Path(sums).read_text().splitlines()
           if len(line.split()) == 2 and line.split()[1].lstrip('*') == archive.name]
if len(matches) != 1 or not re.fullmatch('[a-fA-F0-9]{64}', matches[0]) or hashlib.sha256(archive.read_bytes()).hexdigest() != matches[0].lower():
    raise SystemExit('下载包摘要不匹配，未开始安装。')
with zipfile.ZipFile(archive) as bundle:
    for member in bundle.infolist():
        name = pathlib.PurePosixPath(member.filename)
        if name.is_absolute() or '..' in name.parts or stat.S_ISLNK(member.external_attr >> 16):
            raise SystemExit('下载包包含不安全路径，未开始安装。')
    bundle.extractall(target)
manifest = json.loads((target / 'SOURCE-MANIFEST.json').read_text())
if manifest.get('status') != 'RELEASE_SOURCE' or manifest.get('version') != version[1:]:
    raise SystemExit('下载包不是指定的正式版本。')
for name, digest in manifest['files'].items():
    file = (target / name).resolve()
    if not file.is_relative_to(target.resolve()) or hashlib.sha256(file.read_bytes()).hexdigest() != digest:
        raise SystemExit('源码文件校验失败，未开始安装。')
PY
fi

printf '%s\n' '正在安装程序，保留已有产品资料和配置…'
if ! "$PYTHON_BIN" "$SOURCE/tools/manage_install.py" install --source "$SOURCE" --prefix "$PREFIX" --bin-dir "$BIN_DIR" --repo "$REPO.git" --ref main >"$TEMP/install.log" 2>&1; then
  cat "$TEMP/install.log" >&2
  fail '安装未完成；已有服务运行时，请先在其终端按 Ctrl+C 后重试。'
fi
"$PYTHON_BIN" "$PREFIX/current/tools/manage_install.py" doctor --prefix "$PREFIX" >"$TEMP/doctor.json"
EXTENSION=$("$PYTHON_BIN" -c 'import json,sys; print(json.load(open(sys.argv[1]))["extension"])' "$TEMP/doctor.json")
printf '\n安装完成。\n扩展目录：%s\n命令位置：%s/backlink-kit\n' "$EXTENSION" "$BIN_DIR"
printf '%s\n' '下一步：创建你的产品，再启动本机服务。详见 README 的“第一次使用”。'
if [ "$OPEN_BROWSER" = 1 ]; then
  if [ -d '/Applications/Microsoft Edge.app' ]; then open -a 'Microsoft Edge' 'edge://extensions/' || true
  elif [ -d '/Applications/Google Chrome.app' ]; then open -a 'Google Chrome' 'chrome://extensions/' || true
  fi
fi
