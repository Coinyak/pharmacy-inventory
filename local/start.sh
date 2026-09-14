#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 local/server.py "$@"
fi
if command -v python >/dev/null 2>&1; then
  exec python local/server.py "$@"
fi
echo "Python 3이 필요합니다." >&2
exit 1
