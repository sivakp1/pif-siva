"""BE-09 shared stats definitions: latency histogram buckets and percentile approximation."""

from __future__ import annotations

# Upper edges (ms) of 12 log-spaced buckets lat_b0 … lat_b11. The last bucket is open-ended.
LAT_EDGES = [10, 20, 40, 70, 100, 150, 250, 400, 700, 1200, 2500, float("inf")]
OPEN_BUCKET_REPORT_MS = 5000
COUNTERS = ("total", "allow", "flag", "sanitize", "block", "degraded", "judge_calls", "judged")


def bucket_index(latency_ms: float) -> int:
    for i, edge in enumerate(LAT_EDGES):
        if latency_ms < edge:
            return i
    return len(LAT_EDGES) - 1


def percentile(hist: list[int], q: float) -> float | None:
    """Approximate percentile from bucket counts (upper bucket edge)."""
    total = sum(hist)
    if total == 0:
        return None
    target = q * total
    cum = 0
    for i, n in enumerate(hist):
        cum += n
        if cum >= target:
            edge = LAT_EDGES[i]
            return OPEN_BUCKET_REPORT_MS if edge == float("inf") else edge
    return OPEN_BUCKET_REPORT_MS


def stats_pk(app_id: str, origin: str) -> str:
    return f"APP#{app_id}#PLAYGROUND" if origin == "playground" else f"APP#{app_id}"


def stats_sk(ts_iso: str) -> str:
    return f"DAY#{ts_iso[:10]}#HOUR#{ts_iso[11:13]}"
