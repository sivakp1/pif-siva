"""CORE-07 encoded-payload detection and decoding (max depth 2)."""

from __future__ import annotations

import base64
import binascii
import re
from urllib.parse import unquote

MAX_DEPTH = 2
PRINTABLE_RATIO = 0.8

_B64 = re.compile(r"(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{24,}={0,2}(?![A-Za-z0-9+/=_-])")
_HEX = re.compile(r"(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}){16,}(?![0-9A-Fa-f])")
_PCT = re.compile(r"(?:%[0-9A-Fa-f]{2}){3,}")


def _printable(text: str) -> bool:
    if not text.strip():
        return False
    ok = sum(1 for ch in text if ch.isprintable() or ch in "\n\t ")
    return ok / len(text) >= PRINTABLE_RATIO


def _as_text(raw: bytes) -> str | None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return text if _printable(text) else None


def _decode_b64(s: str) -> str | None:
    s = s.rstrip("=")
    s += "=" * (-len(s) % 4)
    try:
        raw = base64.urlsafe_b64decode(s) if ("-" in s or "_" in s) else base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        return None
    return _as_text(raw)


def _decode_hex(s: str) -> str | None:
    try:
        return _as_text(bytes.fromhex(s))
    except ValueError:
        return None


def find_encoded(text: str) -> list[str]:
    """Decoded payloads found directly in text (one level), in order of appearance."""
    found: list[tuple[int, str]] = []
    taken: list[tuple[int, int]] = []
    for m in _HEX.finditer(text):
        decoded = _decode_hex(m.group(0))
        if decoded:
            found.append((m.start(), decoded))
            taken.append(m.span())
    for m in _B64.finditer(text):
        if any(a <= m.start() < b for a, b in taken):
            continue
        decoded = _decode_b64(m.group(0))
        if decoded:
            found.append((m.start(), decoded))
            taken.append(m.span())
    for m in _PCT.finditer(text):
        try:
            decoded = unquote(m.group(0), errors="strict")
        except UnicodeDecodeError:
            continue
        if _printable(decoded):
            found.append((m.start(), decoded))
    found.sort(key=lambda t: t[0])
    return [d for _, d in found]


def decode_layers(text: str, depth: int = MAX_DEPTH) -> list[str]:
    """All decoded payloads up to `depth` levels, depth-first in order."""
    if depth <= 0:
        return []
    out: list[str] = []
    for decoded in find_encoded(text):
        out.append(decoded)
        out.extend(decode_layers(decoded, depth - 1))
    return out
