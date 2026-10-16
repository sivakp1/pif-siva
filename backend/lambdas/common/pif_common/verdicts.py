"""BE-07 verdict items. Only a keyed hash and a redacted snippet of raw text are stored (P1)."""

from __future__ import annotations

import os
import time

from pif_core.normalize import normalize

from .aws import to_ddb
from .ids import hmac_hex
from .pii import redact, snippet

TTL_DAYS = int(os.environ.get("VERDICT_TTL_DAYS", "30"))
_REASON_MAX = 300


def _safe_reason(text: str | None) -> str | None:
    if not text:
        return text
    red = redact(text)
    return red if len(red) <= _REASON_MAX else red[: _REASON_MAX - 1] + "…"


def segments_summary(result: dict) -> list[dict]:
    out = []
    for s in result.get("segments", []):
        layers = s.get("layers", {})
        judge = layers.get("judge") or {}
        cls = layers.get("classifier") or {}
        out.append(
            {
                "ref": s["ref"],
                "source": s["source"],
                "trust": s["trust"],
                "risk": s["risk"],
                "action": s["action"],
                "sanitize_mode": s.get("sanitize_mode"),
                "parent": s.get("parent"),
                "heuristic": {"score": layers.get("heuristic", {}).get("score", 0), "rules": layers.get("heuristic", {}).get("rules", [])},
                "classifier": {"score": cls.get("score"), "chunks": cls.get("chunks"), "skipped": cls.get("skipped")},
                "judge": {
                    "label": judge.get("label"),
                    "confidence": judge.get("confidence"),
                    "category": judge.get("category"),
                    "reason": _safe_reason(judge.get("reason")),
                    "skipped": judge.get("skipped"),
                },
            }
        )
    return out


def stored_findings(result: dict) -> list[dict]:
    """Findings keep category/severity/layer/reason and offsets but never text."""
    out = []
    for f in result.get("findings", []):
        out.append(
            {
                "ref": f["ref"],
                "category": f["category"],
                "severity": f["severity"],
                "layer": f["layer"],
                "reason": _safe_reason(f.get("reason")) if f["layer"] == "judge" else f.get("reason"),
                "span": f.get("span"),
                "rule_id": f.get("rule_id"),
            }
        )
    return out


def input_hash(pepper: bytes, texts: list[str]) -> str:
    return hmac_hex(pepper, "\x1e".join(normalize(t) for t in texts))


def build_item(
    *,
    app_id: str,
    verdict_id: str,
    ts_iso: str,
    result: dict,
    origin: str,
    texts: list[str],
    pepper: bytes,
    total_latency_ms: int,
    metadata: dict | None = None,
    extra_segments: list[dict] | None = None,
) -> dict:
    segs = segments_summary(result)
    if extra_segments:
        segs.extend(extra_segments)
    categories = {f["category"] for f in result.get("findings", [])}
    action = result["action"]
    latency = dict(result.get("latency_ms", {}))
    latency["total"] = total_latency_ms
    item = {
        "pk": f"APP#{app_id}",
        "sk": f"TS#{ts_iso}#{verdict_id}",
        "verdict_id": verdict_id,
        "app_id": app_id,
        "ts": ts_iso,
        "gsi_action_pk": f"APP#{app_id}#ACT#{action}",
        "action": action,
        "would_action": result.get("would_action"),
        "risk_score": float(result.get("risk_score", 0.0)),
        "degraded": bool(result.get("degraded")),
        "mode": "monitor" if "would_action" in result else "enforce",
        "origin": origin,
        "categories": categories or None,
        "segments_summary": segs,
        "findings": stored_findings(result),
        "input_hash": input_hash(pepper, texts),
        "snippet": snippet(next((t for t in texts if t and t.strip()), "")),
        "latency_ms": latency,
        "versions": result.get("versions", {}),
        "judge_calls": sum(1 for s in segs if s["judge"]["label"]),
        "ttl": int(time.time()) + TTL_DAYS * 86400,
    }
    if metadata:
        item["metadata_hashes"] = {k: hmac_hex(pepper, str(v)) for k, v in metadata.items() if v is not None}
    return to_ddb(item)
