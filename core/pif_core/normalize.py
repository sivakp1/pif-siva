"""CORE-04 normalization and CORE-05 invisible-character handling."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# CORE-05 invisible characters
_ZERO_WIDTH = {0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF}
_BIDI = set(range(0x202A, 0x202F)) | set(range(0x2066, 0x206A))
_TAG_START, _TAG_END = 0xE0000, 0xE007F

INVISIBLE_FINDING_THRESHOLD = 3  # "more than 3" emits invisible_unicode

# Subset of the Unicode confusables skeleton mapping commonly abused homoglyphs
# to ASCII. Every mapping is one char -> one char so folded offsets equal
# normalized offsets.
_CONFUSABLES = {
    # Cyrillic
    "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o",
    "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ѕ": "s", "і": "i", "ї": "i",
    "ј": "j", "ԁ": "d", "һ": "h", "ԛ": "q", "ԝ": "w", "ɡ": "g", "ӏ": "l",
    # Greek
    "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o",
    "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "γ": "y", "μ": "u",
    # Latin look-alikes
    "ı": "i", "ł": "l", "ø": "o", "ß": "b", "ƅ": "b", "ɑ": "a", "ɩ": "i", "ʀ": "r",
    "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ɢ": "g", "ʜ": "h", "ɪ": "i",
    "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ᴛ": "t",
    "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z",
}
_LEET = {"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t"}

_HSPACE_RUN = re.compile(r"[^\S\n]+")
_BLANK_LINES = re.compile(r"\n{3,}")


@dataclass(frozen=True)
class InvisibleScan:
    text: str  # input with invisible characters removed
    count: int  # number of invisible characters removed
    tag_text: str  # Unicode tag characters decoded to ASCII ("ASCII smuggling")


def strip_invisible(text: str) -> InvisibleScan:
    out: list[str] = []
    tags: list[str] = []
    count = 0
    for ch in text:
        cp = ord(ch)
        if cp in _ZERO_WIDTH or cp in _BIDI:
            count += 1
        elif _TAG_START <= cp <= _TAG_END:
            count += 1
            ascii_cp = cp - _TAG_START
            if 0x20 <= ascii_cp <= 0x7E:
                tags.append(chr(ascii_cp))
        else:
            out.append(ch)
    return InvisibleScan("".join(out), count, "".join(tags))


def normalize(text: str) -> str:
    """NFKC, CRLF -> LF, whitespace runs collapsed."""
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _HSPACE_RUN.sub(" ", text)
    text = _BLANK_LINES.sub("\n\n", text)
    return text.strip()


def fold(normalized: str) -> str:
    """Lower-case, homoglyph skeleton, leetspeak digits. Length-preserving."""
    out: list[str] = []
    for ch in normalized:
        lower = ch.lower()
        if len(lower) != 1:
            lower = ch
        lower = _CONFUSABLES.get(lower, lower)
        lower = _LEET.get(lower, lower)
        out.append(lower)
    return "".join(out)
