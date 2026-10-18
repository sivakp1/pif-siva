"""Layer 1: heuristic rules (CORE-09 … CORE-13)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources

import yaml

from .normalize import fold

SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
DENY_WEIGHT = 0.8
DEFAULT_RULES_VERSION = "v2"


@dataclass(frozen=True)
class Rule:
    id: str
    category: str
    description: str
    pattern: re.Pattern
    match_on: str
    weight: float
    severity: str
    span: bool
    builtin: bool = True
    judge_floor: bool = False
    judge_trigger: bool = False


@dataclass(frozen=True)
class RuleSet:
    version: str
    rules: tuple[Rule, ...]


def _compile(raw: dict, builtin: bool = True) -> Rule:
    weight = float(raw["weight"])
    if not 0 < weight <= 1:
        raise ValueError(f"rule {raw['id']}: weight must be in (0, 1]")
    if raw.get("match_on", "folded") not in ("folded", "normalized"):
        raise ValueError(f"rule {raw['id']}: match_on must be folded or normalized")
    return Rule(
        id=raw["id"],
        category=raw["category"],
        description=raw["description"],
        pattern=re.compile(raw["pattern"], re.IGNORECASE | re.DOTALL),
        match_on=raw.get("match_on", "folded"),
        weight=weight,
        severity=raw.get("severity", "medium"),
        span=bool(raw.get("span", True)),
        builtin=builtin,
        judge_floor=bool(raw.get("judge_floor", False)),
        judge_trigger=bool(raw.get("judge_trigger", False)),
    )


def load_rules_text(text: str) -> RuleSet:
    data = yaml.safe_load(text)
    return RuleSet(version=str(data["version"]), rules=tuple(_compile(r) for r in data["rules"]))


@lru_cache(maxsize=4)
def load_rules(version: str = DEFAULT_RULES_VERSION) -> RuleSet:
    """Loaded once per cold start (CORE-09)."""
    text = resources.files("pif_core").joinpath("rules", f"{version}.yaml").read_text(encoding="utf-8")
    return load_rules_text(text)


def _custom_rules(deny_phrases: list[str]) -> list[Rule]:
    rules = []
    for i, phrase in enumerate(deny_phrases):
        if not phrase.strip():
            continue
        rules.append(
            Rule(
                id=f"CUSTOM-DENY-{i + 1:03d}",
                category="custom_deny",
                description=f'Matches the app deny phrase "{phrase}"',
                pattern=re.compile(re.escape(fold(phrase.strip())), re.IGNORECASE),
                match_on="folded",
                weight=DENY_WEIGHT,
                severity="high",
                span=True,
                builtin=False,
            )
        )
    return rules


def _allow_spans(folded: str, allow_phrases: list) -> list[tuple[int, int, frozenset[str] | None]]:
    """Occurrences of allow phrases. Dict form names rule IDs; string form
    suppresses any overlapping built-in rule match."""
    out = []
    for item in allow_phrases:
        if isinstance(item, dict):
            phrase, ids = item.get("phrase", ""), frozenset(item.get("rule_ids", []))
        else:
            phrase, ids = str(item), None
        phrase = fold(phrase.strip())
        if not phrase:
            continue
        for m in re.finditer(re.escape(phrase), folded):
            out.append((m.start(), m.end(), ids))
    return out


@dataclass(frozen=True)
class Match:
    rule: Rule
    start: int
    end: int

    def to_dict(self) -> dict:
        return {
            "rule_id": self.rule.id,
            "category": self.rule.category,
            "severity": self.rule.severity,
            "reason": self.rule.description,
            "span": {"start": self.start, "end": self.end} if self.rule.span else None,
            "removable": self.rule.span,
        }


def match_rules(
    normalized: str,
    folded: str,
    ruleset: RuleSet,
    *,
    deny_phrases: list[str] | None = None,
    allow_phrases: list | None = None,
) -> list[Match]:
    """Each rule contributes at most once per segment (first match)."""
    allows = _allow_spans(folded, allow_phrases or [])
    matches: list[Match] = []
    for rule in list(ruleset.rules) + _custom_rules(deny_phrases or []):
        text = folded if rule.match_on == "folded" else normalized
        m = rule.pattern.search(text)
        if not m:
            continue
        if rule.builtin and any(
            a < m.end() and m.start() < b and (ids is None or rule.id in ids) for a, b, ids in allows
        ):
            continue
        matches.append(Match(rule, m.start(), m.end()))
    return matches


def noisy_or(weights: list[float]) -> float:
    """CORE-11: h = 1 - prod(1 - w)."""
    prod = 1.0
    for w in weights:
        prod *= 1.0 - w
    return round(1.0 - prod, 6)


def heuristic_score(matches: list[Match]) -> tuple[float, bool]:
    return noisy_or([m.rule.weight for m in matches]), any(m.rule.severity == "critical" for m in matches)


def judge_floor(matches: list[Match]) -> float:
    """CORE-21: noisy-OR of the judge_floor rules. The injection judge cannot label
    harmful-intent requests, so its "benign" verdict must not lower them."""
    return noisy_or([m.rule.weight for m in matches if m.rule.judge_floor])


def judge_trigger(matches: list[Match]) -> bool:
    """CORE-17a: soft-signal rules (persona, forced output, task pivot) route the
    segment to the judge whatever the classifier score."""
    return any(m.rule.judge_trigger for m in matches)
