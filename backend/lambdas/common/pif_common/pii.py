"""BE-08 PII redaction for stored snippets."""

from __future__ import annotations

import re

SNIPPET_MAX = 200

_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b")
_AWS_KEY = re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")
_URL_QUERY = re.compile(r"\bhttps?://[^\s?#]+\?[^\s]*", re.IGNORECASE)
_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_AADHAAR = re.compile(r"\b\d{4}[ -]?\d{4}[ -]?\d{4}\b")
_PHONE = re.compile(
    r"(?:(?<!\w)\+91[\s-]?[6-9]\d{4}[\s-]?\d{5}\b"  # India +91
    r"|(?<!\w)\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}\b"  # international
    r"|\b0?[6-9]\d{9}\b"  # India 10-digit mobile
    r"|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)"  # NANP
)


def luhn_ok(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def _card_sub(m: re.Match) -> str:
    digits = re.sub(r"\D", "", m.group(0))
    if 13 <= len(digits) <= 19 and luhn_ok(digits):
        return "[CARD]"
    return m.group(0)


def redact(text: str) -> str:
    text = _JWT.sub("[JWT]", text)
    text = _AWS_KEY.sub("[AWS_KEY]", text)
    text = _URL_QUERY.sub("[URL]", text)
    text = _EMAIL.sub("[EMAIL]", text)
    text = _CARD.sub(_card_sub, text)
    text = _AADHAAR.sub("[AADHAAR]", text)
    text = _PHONE.sub("[PHONE]", text)
    return text


def snippet(text: str, limit: int = SNIPPET_MAX) -> str:
    """Redact first, then truncate, so a cut can never expose part of a token."""
    red = " ".join(redact(text).split())
    return red if len(red) <= limit else red[: limit - 1] + "…"
