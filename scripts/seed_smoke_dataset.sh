#!/usr/bin/env bash
# Uploads the 150-item smoke set as evaluation dataset "smoke" to the stage's eval bucket.
# Usage: scripts/seed_smoke_dataset.sh <dev|prod>
set -euo pipefail
STAGE="${1:?stage required (dev or prod)}"
cd "$(dirname "$0")/.."
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="pif-eval-${ACCOUNT}-${STAGE}"
python - <<'EOF'
import datetime, hashlib, json, pathlib
items = pathlib.Path("eval/smoke/items.jsonl").read_text(encoding="utf-8")
manifest = {
    "dataset_version": "smoke",
    "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "item_count": len([line for line in items.splitlines() if line.strip()]),
    "items_sha256": hashlib.sha256(items.encode()).hexdigest(),
    "groups": {},
    "sources": [{"source": "pif_eval.synth.smoke_set", "licence": "project"}],
}
for line in items.splitlines():
    if line.strip():
        cat = json.loads(line).get("category", "unknown")
        manifest["groups"][cat] = manifest["groups"].get(cat, 0) + 1
pathlib.Path("smoke-manifest.json").write_text(json.dumps(manifest, indent=2))
EOF
aws s3 cp eval/smoke/items.jsonl "s3://${BUCKET}/datasets/smoke/items.jsonl"
aws s3 cp smoke-manifest.json "s3://${BUCKET}/datasets/smoke/manifest.json"
echo "seeded dataset 'smoke' into s3://${BUCKET}/datasets/smoke/"
