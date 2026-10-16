"""CORE-08: split normalized text into <=512-token chunks with 64-token overlap.

Without a tokenizer, tokens are approximated as word / punctuation runs. The
classifier container re-tokenizes each chunk exactly and truncates at 512.
"""

from __future__ import annotations

import re
from collections.abc import Callable

CHUNK_TOKENS = 512
OVERLAP_TOKENS = 64

_TOKEN = re.compile(r"\w+|[^\w\s]")

Tokenizer = Callable[[str], list[tuple[int, int]]]


def approx_token_spans(text: str) -> list[tuple[int, int]]:
    return [m.span() for m in _TOKEN.finditer(text)]


def chunk_text(
    text: str,
    *,
    size: int = CHUNK_TOKENS,
    overlap: int = OVERLAP_TOKENS,
    tokenizer: Tokenizer | None = None,
) -> list[str]:
    if not text.strip():
        return []
    spans = (tokenizer or approx_token_spans)(text)
    if len(spans) <= size:
        return [text]
    chunks: list[str] = []
    step = size - overlap
    for start in range(0, len(spans), step):
        window = spans[start : start + size]
        chunks.append(text[window[0][0] : window[-1][1]])
        if start + size >= len(spans):
            break
    return chunks
