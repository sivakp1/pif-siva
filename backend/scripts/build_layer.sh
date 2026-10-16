#!/usr/bin/env bash
# Builds backend/build/layer for the pif_core Lambda layer (Linux x86_64, Python 3.12).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
OUT=build/layer/python
rm -rf build/layer
mkdir -p "$OUT"
python -m pip install --quiet \
  --platform manylinux2014_x86_64 --implementation cp --python-version 3.12 --only-binary=:all: \
  --target "$OUT" -r lambdas/layer-requirements.txt
cp -r "$ROOT/core/pif_core" "$OUT/"
cp -r lambdas/common/pif_common "$OUT/"
cp -r "$ROOT/eval/pif_eval" "$OUT/"
find build/layer -name '__pycache__' -type d -prune -exec rm -rf {} +
echo "layer built at backend/build/layer ($(du -sh build/layer | cut -f1))"
