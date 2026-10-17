"""CORE-20 / CORE-21: pure score fusion."""

from __future__ import annotations

from .models import JudgeResult

CRITICAL_FLOOR = 0.95


def fuse(h: float, c: float | None, judge: JudgeResult | None, critical: bool, floor: float = 0.0) -> float:
    p = h if c is None else max(h, c)
    if judge is not None and judge.label == "injection":
        r = max(p, 0.5 + 0.5 * judge.confidence)
    elif judge is not None and judge.label == "benign":
        r = min(p, 0.5 - 0.5 * judge.confidence)
    else:
        r = p
    r = max(r, floor)
    if critical:
        r = max(r, CRITICAL_FLOOR)
    return round(min(max(r, 0.0), 1.0), 6)
