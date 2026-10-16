"""Local evaluation runner (EVAL-08): same pif_core scan path and metrics as the cloud runner."""

from __future__ import annotations

import json
import time
from pathlib import Path

from pif_core import Policy, scan
from pif_core.models import Segment

from .metrics import config_metrics, misclassified

DOC_SOURCES = {"web", "file", "email", "tool", "rag"}


def item_segments(item: dict) -> list[Segment]:
    segs = []
    if item.get("input"):
        segs.append(Segment(ref="input", source="user", content=item["input"]))
    for i, d in enumerate(item.get("context_docs") or []):
        if isinstance(d, str):
            segs.append(Segment(ref=f"context_docs[{i}]", source="rag", content=d))
        else:
            src = d.get("source_type", "rag")
            segs.append(Segment(ref=f"context_docs[{i}]", source=src if src in DOC_SOURCES else "rag", content=d["content"], content_type=d.get("content_type", "text")))
    return segs


def predict(item: dict, config: str, classifier=None, judge=None, policy: dict | None = None) -> dict:
    use_cls = "L2" in config
    use_judge = "L3" in config
    pol = Policy.from_dict({**(policy or {}), "judge_enabled": use_judge})
    t0 = time.perf_counter()
    result = scan(item_segments(item), pol, classifier if use_cls else None, judge if use_judge else None, enforce_limits=False, nonce="000000000000")
    latency = int((time.perf_counter() - t0) * 1000)
    return {
        "id": item["id"],
        "label": item["label"],
        "category": item.get("category"),
        "action": result["action"],
        "risk": result["risk_score"],
        "latency_ms": latency,
        "layer_latency_ms": result["latency_ms"],
        "judge_calls": sum(1 for s in result["segments"] if s["layers"]["judge"].get("label")),
        "degraded": result["degraded"],
    }


def load_items(path: Path, split: str | None = None) -> list[dict]:
    items = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [i for i in items if not split or i.get("split") == split]


def run(items: list[dict], config: str, classifier=None, judge=None, with_sweep: bool = True) -> tuple[dict, list[dict]]:
    if "L2" in config and classifier is None:
        raise SystemExit(f"config {config} needs --model-dir with the ONNX classifier")
    preds = [predict(it, config, classifier, judge) for it in items]
    metrics = config_metrics(preds, config, with_sweep=with_sweep)
    metrics["misclassified"] = misclassified(preds, {i["id"]: i for i in items}, limit=50)
    return metrics, preds
