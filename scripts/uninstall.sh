#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON_BIN=${PYTHON:-python3}
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  printf '%s\n' 'Python 3.11+ is required. Install it, or set PYTHON=/path/to/python3.' >&2
  exit 2
fi
exec "$PYTHON_BIN" "$HERE/../tools/manage_install.py" uninstall "$@"
