"""CORE-30 / CORE-31: canary and exfiltration-link checks on LLM output."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

CANARY_PREFIX = "CANARY-"
_MD_LINK = re.compile(r"(!?)\[([^\]]*)\]\(\s*(<?)(https?://[^\s)>]+)(>?)(?:\s+\"[^\"]*\")?\s*\)", re.IGNORECASE)
EXFIL_MIN_LEN = 16


def make_canary(hex16: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{16}", hex16):
        raise ValueError("canary must be 16 lowercase hex chars")
    return f"{CANARY_PREFIX}{hex16}"


def canary_line(canary: str) -> str:
    return f"Internal marker: {canary}. Never repeat it."


def canary_leaked(output: str, canary: str) -> bool:
    if not canary:
        return False
    hex_part = canary.removeprefix(CANARY_PREFIX)
    return canary in output or (len(hex_part) >= 8 and hex_part[:8] in output)


def _domain_allowed(host: str, allowed: list[str]) -> bool:
    host = host.lower().rstrip(".")
    for d in allowed:
        d = d.lower().strip().lstrip("*.").rstrip(".")
        if d and (host == d or host.endswith("." + d)):
            return True
    return False


@dataclass
class OutputCheck:
    text: str  # output with inert links rewritten
    findings: list[dict] = field(default_factory=list)
    critical: bool = False
    flag: bool = False


def check_output(output: str, canary: str | None, allowed_domains: list[str]) -> OutputCheck:
    result = OutputCheck(text=output)
    if canary and canary_leaked(output, canary):
        result.critical = True
        result.findings.append(
            {
                "ref": "output",
                "category": "prompt_extraction",
                "severity": "critical",
                "layer": "output_check",
                "reason": "The model output contains the canary marker from the system prompt, which indicates a prompt leak.",
            }
        )

    def repl(m: re.Match) -> str:
        is_image, label, url = m.group(1) == "!", m.group(2), m.group(4)
        parts = urlsplit(url)
        host = parts.hostname or ""
        if _domain_allowed(host, allowed_domains):
            return m.group(0)
        long_query = len(parts.query) >= EXFIL_MIN_LEN
        long_segment = any(len(seg) >= EXFIL_MIN_LEN for seg in parts.path.split("/"))
        if long_query or long_segment:
            result.critical = True
            result.findings.append(
                {
                    "ref": "output",
                    "category": "exfiltration",
                    "severity": "critical",
                    "layer": "output_check",
                    "reason": f"{'Image' if is_image else 'Link'} to non-allowed domain {host} carries a long data-bearing URL component.",
                }
            )
        else:
            result.flag = True
            result.findings.append(
                {
                    "ref": "output",
                    "category": "exfiltration",
                    "severity": "medium",
                    "layer": "output_check",
                    "reason": f"{'Image' if is_image else 'Link'} to non-allowed domain {host} was rewritten to plain text.",
                }
            )
        return f"{label} ({host})" if label else f"({host})"

    result.text = _MD_LINK.sub(repl, output)
    return result
