"""CORE-23 / CORE-24: action decision table."""

from __future__ import annotations

from .models import ACTION_ORDER
from .policy import Policy


def segment_action(trust: str, r: float, policy: Policy) -> tuple[str, str | None]:
    """Returns (action, sanitize_mode) where sanitize_mode is 'clean' | 'drop' | None."""
    if trust == "user":
        if r >= policy.block:
            return "block", None
        if r >= policy.flag:
            return "flag", None
        return "allow", None
    if trust == "untrusted":
        if r >= policy.block:
            return ("block", None) if policy.block_on_context else ("sanitize", "drop")
        if r >= policy.sanitize:
            return "sanitize", "clean"
        if r >= policy.flag:
            return "flag", None
        return "allow", None
    # output
    if r >= policy.sanitize:
        return "block", None
    if r >= policy.flag:
        return "flag", None
    return "allow", None


def most_severe(actions: list[str]) -> str:
    return max(actions, key=lambda a: ACTION_ORDER[a], default="allow")
