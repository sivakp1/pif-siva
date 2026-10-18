from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

SOURCES = ("user", "web", "file", "email", "tool", "rag", "llm_output")
TRUSTS = ("user", "untrusted", "output")
CONTENT_TYPES = ("text", "html", "markdown")
ACTIONS = ("allow", "flag", "sanitize", "block")
ACTION_ORDER = {a: i for i, a in enumerate(ACTIONS)}
SEVERITIES = ("low", "medium", "high", "critical")

CATEGORIES = (
    "instruction_override",
    "role_hijack",
    "prompt_extraction",
    "exfiltration",
    "tool_abuse",
    "obfuscation_hint",
    "hidden_instruction",
    "invisible_unicode",
    "delimiter_spoof",
    # CORE-10a: harmful intent that is not prompt injection
    "harmful_request",
    "privacy_violation",
    "reconnaissance",
)


def trust_for_source(source: str) -> str:
    if source == "user":
        return "user"
    if source == "llm_output":
        return "output"
    return "untrusted"


@dataclass(frozen=True)
class Segment:
    """CORE-01: one unit of text to scan."""

    ref: str
    source: str
    content: str
    content_type: str = "text"
    trust: str | None = None

    def __post_init__(self) -> None:
        if self.source not in SOURCES:
            raise ValueError(f"segment source must be one of {SOURCES}")
        if self.content_type not in CONTENT_TYPES:
            raise ValueError(f"segment content_type must be one of {CONTENT_TYPES}")
        if self.trust is None:
            object.__setattr__(self, "trust", trust_for_source(self.source))
        elif self.trust not in TRUSTS:
            raise ValueError(f"segment trust must be one of {TRUSTS}")


@dataclass(frozen=True)
class JudgeResult:
    label: str  # injection | benign | uncertain
    confidence: float = 0.0
    category: str = "none"
    evidence: str = ""
    reason: str = ""
    degraded: bool = False  # True when the judge errored or returned invalid JSON twice


class Classifier(Protocol):
    version: str

    def score(self, chunks: list[str]) -> list[float]: ...


class Judge(Protocol):
    model_id: str

    def assess(self, segment: ScanSegment, context: dict) -> JudgeResult: ...


@dataclass
class ScanSegment:
    """A segment after pre-processing; may be derived from a parent."""

    ref: str
    parent_ref: str
    source: str
    trust: str
    content_type: str
    normalized: str
    folded: str
    derived_kind: str | None = None  # hidden | tags | decoded
    hidden_text: str = ""  # for parents: hidden text removed from visible content
    invisible_count: int = 0
    tag_text: str = ""
    # filled during scanning
    h: float = 0.0
    rule_ids: list[str] = field(default_factory=list)
    matches: list[dict] = field(default_factory=list)
    critical: bool = False
    floor: float = 0.0  # CORE-21: risk the judge cannot lower (judge_floor rules)
    judge_trigger: bool = False  # CORE-17a: a soft rule fired, so the judge runs below the gray zone
    c: float | None = None
    chunks: int = 0
    judge: JudgeResult | None = None
    judge_skip_reason: str | None = None
    risk: float = 0.0
    action: str = "allow"

    @property
    def p(self) -> float:
        return self.h if self.c is None else max(self.h, self.c)
