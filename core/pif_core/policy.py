"""CORE-22: per-app policy, defaults and validation."""

from __future__ import annotations

import copy
from dataclasses import dataclass, field

from .errors import PolicyError

DEFAULT_POLICY: dict = {
    "mode": "enforce",
    "fail_mode": "open",
    "thresholds": {"flag": 0.50, "sanitize": 0.70, "block": 0.85},
    "gray_zone": {"low": 0.30, "high": 0.80},
    "judge_enabled": True,
    "judge_budget": 3,
    "block_on_context": False,
    "output_checks": True,
    "custom_rules": {"deny_phrases": [], "allow_phrases": []},
}


def default_policy() -> dict:
    return copy.deepcopy(DEFAULT_POLICY)


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def _num(value, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PolicyError(f"{name} must be a number")
    return float(value)


def validate_policy(raw: dict) -> dict:
    """Return the merged policy dict or raise PolicyError naming the violated constraint."""
    p = _merge(DEFAULT_POLICY, raw or {})
    unknown = set(p) - set(DEFAULT_POLICY)
    if unknown:
        raise PolicyError(f"unknown policy field(s): {', '.join(sorted(unknown))}")
    if p["mode"] not in ("enforce", "monitor"):
        raise PolicyError("mode must be 'enforce' or 'monitor'")
    if p["fail_mode"] not in ("open", "closed"):
        raise PolicyError("fail_mode must be 'open' or 'closed'")
    t = p["thresholds"]
    flag, san, blk = (_num(t.get(k), f"thresholds.{k}") for k in ("flag", "sanitize", "block"))
    if not 0 < flag:
        raise PolicyError("thresholds.flag must be > 0 (constraint: 0 < flag ≤ sanitize ≤ block ≤ 1)")
    if not flag <= san:
        raise PolicyError("thresholds.flag must be ≤ thresholds.sanitize (constraint: 0 < flag ≤ sanitize ≤ block ≤ 1)")
    if not san <= blk:
        raise PolicyError("thresholds.sanitize must be ≤ thresholds.block (constraint: 0 < flag ≤ sanitize ≤ block ≤ 1)")
    if not blk <= 1:
        raise PolicyError("thresholds.block must be ≤ 1 (constraint: 0 < flag ≤ sanitize ≤ block ≤ 1)")
    g = p["gray_zone"]
    low, high = _num(g.get("low"), "gray_zone.low"), _num(g.get("high"), "gray_zone.high")
    if not (0 <= low < high <= 1):
        raise PolicyError("gray_zone must satisfy 0 ≤ gray_zone.low < gray_zone.high ≤ 1")
    for key in ("judge_enabled", "block_on_context", "output_checks"):
        if not isinstance(p[key], bool):
            raise PolicyError(f"{key} must be a boolean")
    if isinstance(p["judge_budget"], bool) or not isinstance(p["judge_budget"], int) or not 0 <= p["judge_budget"] <= 20:
        raise PolicyError("judge_budget must be an integer between 0 and 20")
    cr = p["custom_rules"]
    if not isinstance(cr.get("deny_phrases"), list) or not isinstance(cr.get("allow_phrases"), list):
        raise PolicyError("custom_rules.deny_phrases and custom_rules.allow_phrases must be lists")
    if len(cr["deny_phrases"]) > 200 or len(cr["allow_phrases"]) > 200:
        raise PolicyError("custom_rules lists may hold at most 200 entries each")
    return p


@dataclass(frozen=True)
class Policy:
    """Validated, resolved policy used by the scanner."""

    mode: str = "enforce"
    fail_mode: str = "open"
    flag: float = 0.50
    sanitize: float = 0.70
    block: float = 0.85
    gray_low: float = 0.30
    gray_high: float = 0.80
    judge_enabled: bool = True
    judge_budget: int = 3
    block_on_context: bool = False
    output_checks: bool = True
    deny_phrases: tuple = field(default_factory=tuple)
    allow_phrases: tuple = field(default_factory=tuple)
    version: int = 0

    @classmethod
    def from_dict(cls, raw: dict | None = None, version: int = 0) -> Policy:
        p = validate_policy(raw or {})
        return cls(
            mode=p["mode"],
            fail_mode=p["fail_mode"],
            flag=float(p["thresholds"]["flag"]),
            sanitize=float(p["thresholds"]["sanitize"]),
            block=float(p["thresholds"]["block"]),
            gray_low=float(p["gray_zone"]["low"]),
            gray_high=float(p["gray_zone"]["high"]),
            judge_enabled=p["judge_enabled"],
            judge_budget=p["judge_budget"],
            block_on_context=p["block_on_context"],
            output_checks=p["output_checks"],
            deny_phrases=tuple(p["custom_rules"]["deny_phrases"]),
            allow_phrases=tuple(p["custom_rules"]["allow_phrases"]),
            version=version,
        )
