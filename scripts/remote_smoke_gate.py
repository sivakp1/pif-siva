"""EVAL-07 gate against the deployed classifier: scans the smoke set with L1+L2 through
the orchestrator's internal eval handler (EVAL-06: no verdicts are written).

If the baseline file does not exist yet, it is created and the gate passes; commit it.
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eval"))
from pif_eval.metrics import compare_to_baseline, config_metrics  # noqa: E402


def orchestrator_name(stage: str) -> str:
    cfn = boto3.client("cloudformation")
    outs = cfn.describe_stacks(StackName=f"pif-{stage}-api")["Stacks"][0]["Outputs"]
    return next(o["OutputValue"] for o in outs if o["OutputKey"] == "OrchestratorFunctionName")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="dev")
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--config", default="L1+L2")
    args = ap.parse_args()
    fn = orchestrator_name(args.stage)
    lam = boto3.client("lambda")
    items = [json.loads(line) for line in (ROOT / "eval" / "smoke" / "items.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]

    def scan(item):
        resp = lam.invoke(FunctionName=fn, Payload=json.dumps({"internal": "eval_scan", "item": item, "config": args.config}).encode())
        return json.loads(resp["Payload"].read())

    with ThreadPoolExecutor(max_workers=8) as pool:
        preds = list(pool.map(scan, items))
    m = config_metrics(preds, args.config, with_sweep=False)
    summary = {k: m[k] for k in ("n", "recall", "fpr", "precision", "f1", "p95_ms")}
    print(json.dumps(summary, indent=2))
    degraded = sum(1 for p in preds if p.get("degraded"))
    if degraded > len(preds) * 0.2:
        print(f"EVAL GATE FAILED: {degraded} of {len(preds)} scans were degraded (classifier unavailable?)", file=sys.stderr)
        return 1
    path = Path(args.baseline)
    if not path.exists():
        path.write_text(json.dumps(summary, indent=2) + "\n")
        print(f"no baseline found; wrote {path}. Commit it to enable the regression gate.")
        return 0
    problems = compare_to_baseline(m, json.loads(path.read_text()))
    for p in problems:
        print(f"EVAL GATE FAILED ({args.config}): {p}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
