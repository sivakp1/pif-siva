"""AC-EVAL-1, AC-EVAL-2, AC-EVAL-4 (AC-EVAL-3 lives in backend/tests/unit/test_scan.py)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

import pif_core.scanner as scanner
from pif_core.heuristics import load_rules_text
from pif_eval.metrics import compare_to_baseline, config_metrics
from pif_eval.runner import load_items, run

EVAL_DIR = Path(__file__).resolve().parents[1]
SMOKE = load_items(EVAL_DIR / "smoke" / "items.jsonl")
EVAL04_KEYS = {"tp", "fp", "tn", "fn", "precision", "recall", "f1", "fpr", "fpr_hard", "per_category_recall",
               "p50_ms", "p95_ms", "judge_escalation_rate", "cost_per_1k_usd"}


class HashClassifier:
    """Deterministic stand-in for the ONNX model."""

    version = "hash-1"

    def score(self, chunks):
        return [0.9 if any(w in c.lower() for w in ("ignore", "disregard", "no restrictions", "dan")) else (hash(c) % 7) / 100 for c in chunks]


def test_smoke_set_shape():
    assert len(SMOKE) == 150
    assert sum(1 for i in SMOKE if i["label"] == "attack") == 60


def test_AC_EVAL_1_metrics_present_for_each_config():
    preds = [{"id": "a", "label": "attack", "category": "direct", "action": "block", "risk": 0.9, "latency_ms": 10, "judge_calls": 1},
             {"id": "b", "label": "benign", "category": "benign_hard", "action": "allow", "risk": 0.1, "latency_ms": 12, "judge_calls": 0}]
    for cfg in ("L1", "L1+L2", "L1+L2+L3", "bedrock_guardrails"):
        m = config_metrics(preds, cfg)
        assert EVAL04_KEYS <= set(m), cfg
        assert len(m["sweep"]) == 19


def test_AC_EVAL_2_repeatable_counts():
    clf = HashClassifier()
    a, _ = run(SMOKE, "L1+L2", clf, with_sweep=False)
    b, _ = run(SMOKE, "L1+L2", clf, with_sweep=False)
    assert {k: a[k] for k in ("tp", "fp", "tn", "fn")} == {k: b[k] for k in ("tp", "fp", "tn", "fn")}


def test_AC_EVAL_4_weakened_rules_fail_gate(monkeypatch):
    baseline = json.loads((EVAL_DIR / "smoke" / "baseline.L1.json").read_text())
    good, _ = run(SMOKE, "L1", with_sweep=False)
    assert compare_to_baseline(good, baseline) == []

    rules_path = Path(scanner.__file__).parent / "rules" / "v1.yaml"
    data = yaml.safe_load(rules_path.read_text(encoding="utf-8"))
    data["rules"] = [r for r in data["rules"] if r["category"] not in ("instruction_override", "role_hijack")]
    weak = load_rules_text(yaml.safe_dump(data))
    monkeypatch.setattr(scanner, "load_rules", lambda version="v1": weak)
    bad, _ = run(SMOKE, "L1", with_sweep=False)
    problems = compare_to_baseline(bad, baseline)
    assert problems and "recall" in problems[0]


@pytest.mark.parametrize("cfg", ["L1"])
def test_local_cli_runs(cfg, tmp_path):
    from pif_eval.__main__ import main

    items = tmp_path / "items.jsonl"
    items.write_text("\n".join(json.dumps({**i, "split": "test"}) for i in SMOKE[:20]))
    assert main(["run", "--config", cfg, "--items", str(items), "--out", str(tmp_path / "out.json")]) == 0
    assert json.loads((tmp_path / "out.json").read_text())["n"] == 20
