from __future__ import annotations

from .errors import PayloadTooLarge

MAX_TOTAL_BYTES = 64 * 1024
MAX_CONTEXT_DOCS = 20
MAX_SEGMENT_BYTES = 32 * 1024


def check_limits(
    contents: list[str],
    context_doc_count: int,
    *,
    max_total: int = MAX_TOTAL_BYTES,
    max_docs: int = MAX_CONTEXT_DOCS,
    max_segment: int = MAX_SEGMENT_BYTES,
) -> None:
    """CORE-03. Raises PayloadTooLarge naming the limit that was exceeded."""
    if context_doc_count > max_docs:
        raise PayloadTooLarge(f"context_docs has {context_doc_count} items; the limit is {max_docs}")
    total = 0
    for content in contents:
        size = len(content.encode("utf-8"))
        if size > max_segment:
            raise PayloadTooLarge(f"a segment is {size} bytes; the per-segment limit is {max_segment} bytes")
        total += size
    if total > max_total:
        raise PayloadTooLarge(f"request content is {total} bytes; the total limit is {max_total} bytes")
