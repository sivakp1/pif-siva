"""BE-17 EMF metrics and BE-18 structured logs (never raw text, P1)."""

from __future__ import annotations

import json
import sys
import time

NAMESPACE = "PIF"

# Fields that may appear in log lines. Anything else is dropped so raw input
# or output text can never be logged by accident (AC-BE-12).
_ALLOWED_LOG_FIELDS = {
    "level", "msg", "request_id", "verdict_id", "app_id", "action", "would_action", "risk_score",
    "latency_ms", "versions", "origin", "degraded", "error_code", "error_type", "route", "status",
    "run_id", "count", "user_sub",
}


def log(msg: str, **fields) -> None:
    rec = {"level": fields.pop("level", "info"), "msg": msg}
    for k, v in fields.items():
        if k in _ALLOWED_LOG_FIELDS:
            rec[k] = v
    print(json.dumps(rec, default=str), file=sys.stdout, flush=True)


def emit_metrics(app_id: str | None, metrics: dict[str, float], *, extra_dims: dict[str, str] | None = None, unit_ms: set[str] | None = None) -> None:
    """Emit one EMF record. Metrics with Ms in their name use Milliseconds."""
    if not metrics:
        return
    dims = {"AppId": app_id or "unknown", **(extra_dims or {})}
    unit_ms = unit_ms or {k for k in metrics if k.endswith("Ms")}
    rec = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": NAMESPACE,
                    # per-app series plus an app-agnostic rollup used by the BE-19 alarms
                    "Dimensions": [list(dims.keys()), [k for k in dims if k != "AppId"]],
                    "Metrics": [{"Name": k, "Unit": "Milliseconds" if k in unit_ms else "Count"} for k in metrics],
                }
            ],
        },
        **dims,
        **metrics,
    }
    print(json.dumps(rec), file=sys.stdout, flush=True)


def scan_metrics(app_id: str, result: dict, total_ms: int) -> None:
    lat = result.get("latency_ms", {})
    judge_runs = sum(1 for s in result.get("segments", []) if (s.get("layers", {}).get("judge") or {}).get("label"))
    judge_errors = sum(1 for s in result.get("segments", []) if (s.get("layers", {}).get("judge") or {}).get("degraded"))
    cls_errors = sum(
        1 for s in result.get("segments", []) if (s.get("layers", {}).get("classifier") or {}).get("skipped") == "classifier unavailable"
    )
    emit_metrics(
        app_id,
        {
            "ScanLatencyMs": total_ms,
            "JudgeInvocations": judge_runs,
            "JudgeErrors": judge_errors,
            "ClassifierErrors": 1 if cls_errors else 0,
            "Degraded": 1 if result.get("degraded") else 0,
            "Requests": 1,
            # Judge-free latency feeds the P9 / BE-19 warm p95 alarm
            **({"ScanLatencyNoJudgeMs": total_ms} if judge_runs == 0 else {}),
        },
    )
    for layer in ("l1", "l2", "l3"):
        emit_metrics(app_id, {"LayerLatencyMs": lat.get(layer, 0)}, extra_dims={"Layer": layer.upper()})
    emit_metrics(app_id, {"Actions": 1}, extra_dims={"Action": result.get("action", "allow")})
