"""CLI: python -m pif_eval {run,gate,build-dataset,smoke}

  python -m pif_eval run --config L1+L2 --dataset v1 --model-dir ./model
  python -m pif_eval gate --config L1 --baseline eval/smoke/baseline.L1.json
  python -m pif_eval build-dataset --version v1
  python -m pif_eval smoke            # regenerate eval/smoke/items.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .metrics import compare_to_baseline
from .runner import load_items, run

EVAL_DIR = Path(__file__).resolve().parents[1]


def _classifier(args):
    if args.model_dir:
        from .local_classifier import OnnxClassifier

        return OnnxClassifier(args.model_dir)
    return None


def cmd_run(args) -> int:
    path = Path(args.items) if args.items else EVAL_DIR / "datasets" / args.dataset / "items.jsonl"
    items = load_items(path, args.split)
    metrics, preds = run(items, args.config, _classifier(args))
    out = Path(args.out) if args.out else EVAL_DIR / "results" / f"{args.dataset}-{args.config}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    keys = ("n", "tp", "fp", "tn", "fn", "precision", "recall", "f1", "fpr", "fpr_hard", "p50_ms", "p95_ms")
    print(json.dumps({k: metrics[k] for k in keys}, indent=2))
    print(f"wrote {out}")
    return 0


def cmd_gate(args) -> int:
    items = load_items(EVAL_DIR / "smoke" / "items.jsonl")
    metrics, _ = run(items, args.config, _classifier(args), with_sweep=False)
    print(json.dumps({k: metrics[k] for k in ("recall", "fpr", "precision", "f1")}, indent=2))
    if args.update:
        Path(args.baseline).write_text(json.dumps({k: metrics[k] for k in ("recall", "fpr", "precision", "f1", "n")}, indent=2) + "\n")
        print(f"baseline updated: {args.baseline}")
        return 0
    baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
    problems = compare_to_baseline(metrics, baseline)
    if problems:
        for p in problems:
            print(f"EVAL GATE FAILED ({args.config}): {p}", file=sys.stderr)
        return 1
    print(f"eval gate passed for {args.config}")
    return 0


def cmd_build(args) -> int:
    from .build_dataset import build

    manifest = build(EVAL_DIR / "datasets" / args.version, args.version)
    print(json.dumps({k: manifest[k] for k in ("item_count", "groups", "splits")}, indent=2))
    return 0


def cmd_smoke(_args) -> int:
    from .synth import smoke_set

    path = EVAL_DIR / "smoke" / "items.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(i, ensure_ascii=False) for i in smoke_set()) + "\n", encoding="utf-8")
    print(f"wrote {path}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="pif_eval")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--config", required=True, choices=["L1", "L1+L2"])
    r.add_argument("--dataset", default="v1")
    r.add_argument("--items")
    r.add_argument("--split", default="test")
    r.add_argument("--model-dir")
    r.add_argument("--out")
    r.set_defaults(fn=cmd_run)
    g = sub.add_parser("gate")
    g.add_argument("--config", default="L1", choices=["L1", "L1+L2"])
    g.add_argument("--baseline", required=True)
    g.add_argument("--model-dir")
    g.add_argument("--update", action="store_true")
    g.set_defaults(fn=cmd_gate)
    b = sub.add_parser("build-dataset")
    b.add_argument("--version", default="v1")
    b.set_defaults(fn=cmd_build)
    s = sub.add_parser("smoke")
    s.set_defaults(fn=cmd_smoke)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
