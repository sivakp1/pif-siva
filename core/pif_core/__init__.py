"""PIF core: pure, deterministic prompt-injection detection logic (spec.md §4).

No storage or network I/O happens here (P2, CORE-02). The classifier and judge
are injected by the caller.
"""

from .errors import DetectorUnavailable, PayloadTooLarge, PolicyError
from .models import JudgeResult, Segment
from .policy import Policy, default_policy, validate_policy
from .sanitize import spotlight_instructions
from .scanner import CORE_VERSION, scan, scan_output

__all__ = [
    "CORE_VERSION",
    "DetectorUnavailable",
    "JudgeResult",
    "PayloadTooLarge",
    "Policy",
    "PolicyError",
    "Segment",
    "default_policy",
    "scan",
    "scan_output",
    "spotlight_instructions",
    "validate_policy",
]
