"""Request validation for /v1/scan and /v1/chat (B.2.3, B.2.4)."""

from __future__ import annotations

from pif_common.http import invalid
from pif_core import Segment
from pif_core.models import CONTENT_TYPES, SOURCES

DOC_SOURCES = tuple(s for s in SOURCES if s not in ("user", "llm_output"))


def _str(value, field: str, *, required: bool = False, max_len: int | None = None) -> str | None:
    if value is None:
        if required:
            raise invalid(f"{field} is required")
        return None
    if not isinstance(value, str):
        raise invalid(f"{field} must be a string")
    if max_len is not None and len(value) > max_len:
        raise invalid(f"{field} must be at most {max_len} characters")
    return value


def parse_context_docs(raw, field: str = "context_docs") -> list[Segment]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise invalid(f"{field} must be an array")
    docs = []
    for i, d in enumerate(raw):
        ref = f"context_docs[{i}]"
        if isinstance(d, str):
            docs.append(Segment(ref=ref, source="rag", content=d, content_type="text"))
            continue
        if not isinstance(d, dict):
            raise invalid(f"{field}[{i}] must be a string or an object")
        content = _str(d.get("content"), f"{field}[{i}].content", required=True)
        source = d.get("source_type", "rag")
        ctype = d.get("content_type", "text")
        if source not in DOC_SOURCES:
            raise invalid(f"{field}[{i}].source_type must be one of {', '.join(DOC_SOURCES)}")
        if ctype not in CONTENT_TYPES:
            raise invalid(f"{field}[{i}].content_type must be one of {', '.join(CONTENT_TYPES)}")
        _str(d.get("id"), f"{field}[{i}].id", max_len=200)
        docs.append(Segment(ref=ref, source=source, content=content, content_type=ctype))
    return docs


def parse_options(body: dict) -> dict:
    opts = body.get("options") or {}
    if not isinstance(opts, dict):
        raise invalid("options must be an object")
    out = {"return_sanitized": True, "explain": True}
    for k in out:
        if k in opts:
            if not isinstance(opts[k], bool):
                raise invalid(f"options.{k} must be a boolean")
            out[k] = opts[k]
    return out


def parse_metadata(body: dict) -> dict:
    md = body.get("metadata") or {}
    if not isinstance(md, dict):
        raise invalid("metadata must be an object")
    for k, v in md.items():
        if not isinstance(v, str | int | float):
            raise invalid(f"metadata.{k} must be a string or number")
    return md


def parse_scan(body: dict) -> tuple[str, list[Segment], dict, dict]:
    app_id = _str(body.get("app_id"), "app_id", required=True, max_len=40)
    user_input = _str(body.get("input"), "input")
    docs = parse_context_docs(body.get("context_docs"))
    if not user_input and not docs:
        raise invalid("at least one of input or context_docs is required")
    segments = ([Segment(ref="input", source="user", content=user_input)] if user_input else []) + docs
    return app_id, segments, parse_options(body), parse_metadata(body)


def parse_chat(body: dict) -> dict:
    app_id = _str(body.get("app_id"), "app_id", required=True, max_len=40)
    system = _str(body.get("system"), "system") or ""
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise invalid("messages must be a non-empty array")
    clean = []
    for i, m in enumerate(messages):
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            raise invalid(f"messages[{i}].role must be 'user' or 'assistant'")
        clean.append({"role": m["role"], "content": _str(m.get("content"), f"messages[{i}].content", required=True)})
    if clean[-1]["role"] != "user":
        raise invalid("the last message must have role 'user'")
    params = body.get("model_params") or {}
    if not isinstance(params, dict):
        raise invalid("model_params must be an object")
    max_tokens = params.get("max_tokens", 800)
    temperature = params.get("temperature", 0.2)
    if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or not 1 <= max_tokens <= 4096:
        raise invalid("model_params.max_tokens must be an integer between 1 and 4096")
    if isinstance(temperature, bool) or not isinstance(temperature, int | float) or not 0 <= temperature <= 1:
        raise invalid("model_params.temperature must be between 0 and 1")
    docs = parse_context_docs(body.get("context_docs"))
    segments = [Segment(ref="input", source="user", content=clean[-1]["content"])] + docs
    return {
        "app_id": app_id,
        "system": system,
        "messages": clean,
        "segments": segments,
        "max_tokens": max_tokens,
        "temperature": float(temperature),
        "metadata": parse_metadata(body),
    }
