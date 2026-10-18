"""scan-orchestrator: /v1/scan, /v1/chat, /healthz, plus internal playground and eval invokes."""

from __future__ import annotations

import os
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

from orch_adapters import (
    AnthropicJudge,
    BedrockJudge,
    GeminiJudge,
    LambdaClassifier,
    anthropic_chat_completion,
    chat_completion,
    gemini_chat_completion,
)
from orch_request import parse_chat, parse_context_docs, parse_scan

from pif_common import apps as apps_repo
from pif_common.aws import pepper, ssm_param, table
from pif_common.http import (
    ApiError,
    error_response,
    forbidden,
    internal_error,
    invalid,
    json_body,
    request_id,
    response,
    too_large,
    unauthorized,
    unavailable,
)
from pif_common.ids import ulid
from pif_common.obs import emit_metrics, log, scan_metrics
from pif_common.verdicts import build_item
from pif_core import DetectorUnavailable, PayloadTooLarge, Policy, scan, scan_output, spotlight_instructions
from pif_core.decide import most_severe
from pif_core.errors import PolicyError
from pif_core.models import Segment
from pif_core.output_checks import canary_line, make_canary

MAX_BODY_BYTES = 64 * 1024
REFUSAL = "I can't help with that request."
DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
CLASSIFIER_VERSION = os.environ.get("CLASSIFIER_VERSION", "protectai-deberta-v3-base-pi-v2-onnx-1")

_pool = ThreadPoolExecutor(max_workers=8)


# ----------------------------------------------------------------- injectable layer factories
def make_classifier():
    fn = os.environ.get("CLASSIFIER_FUNCTION")
    return LambdaClassifier(fn, CLASSIFIER_VERSION) if fn else None


_JUDGES = {"bedrock": BedrockJudge, "anthropic": AnthropicJudge, "gemini": GeminiJudge}
_CHATS = {"bedrock": chat_completion, "anthropic": anthropic_chat_completion, "gemini": gemini_chat_completion}


def llm_provider() -> str:
    """'bedrock' (default), 'anthropic' or 'gemini', from SSM so it can change without a deploy."""
    name = (ssm_param("llm_provider", "bedrock") or "").strip().lower()
    return name if name in _JUDGES else "bedrock"


def make_judge():
    return _JUDGES[llm_provider()](ssm_param("judge_model_id", DEFAULT_MODEL))


def chat_model(app: dict) -> str:
    return app.get("chat_model_id") or ssm_param("chat_model_id", DEFAULT_MODEL)


def call_chat(model_id, system, messages, max_tokens, temperature) -> str:
    return _CHATS[llm_provider()](model_id, system, messages, max_tokens, temperature)


# ----------------------------------------------------------------- helpers
def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _policy_for(app: dict, judge_override: bool | None = None) -> Policy:
    raw = dict(app.get("policy") or {})
    if judge_override is not None:
        raw["judge_enabled"] = bool(judge_override)
    try:
        return Policy.from_dict(raw, version=int(app.get("policy_version", 0)))
    except PolicyError as exc:
        raise ApiError(500, "INTERNAL", "stored policy is invalid") from exc


def _run_scan(segments: list[Segment], policy: Policy, *, classifier=True, judge=True) -> dict:
    try:
        return scan(
            segments,
            policy,
            make_classifier() if classifier else None,
            make_judge() if judge else None,
            judge_map=_pool.map,
        )
    except PayloadTooLarge as exc:
        raise too_large(str(exc)) from exc
    except DetectorUnavailable as exc:
        raise unavailable(str(exc)) from exc


def _shape(result: dict, options: dict) -> dict:
    """explain=false omits judge reasons and per-layer details; categories remain."""
    out = dict(result)
    if not options.get("explain", True):
        out["segments"] = [{k: v for k, v in s.items() if k != "layers"} for s in result["segments"]]
        out["findings"] = [
            {k: v for k, v in f.items() if not (k == "reason" and f["layer"] == "judge")} for f in result["findings"]
        ]
    if not options.get("return_sanitized", True):
        out.pop("sanitized", None)
    return out


def _store(item: dict, app_id: str, verdict_id: str) -> None:
    """BE-14: a failed write never fails the scan."""
    try:
        table("TABLE_VERDICTS").put_item(Item=item)
    except Exception as exc:
        emit_metrics(app_id, {"VerdictWriteErrors": 1})
        log("verdict write failed", level="error", verdict_id=verdict_id, app_id=app_id, error_type=type(exc).__name__)


def _auth_app(event: dict) -> str:
    ctx = ((event.get("requestContext") or {}).get("authorizer") or {}).get("lambda") or {}
    if ctx.get("auth_status") != "ok" or not ctx.get("app_id"):
        raise unauthorized("missing or invalid API key")
    prev = ctx.get("prev_expires_at")
    if prev and datetime.fromisoformat(prev.replace("Z", "+00:00")) <= datetime.now(UTC):
        raise unauthorized("API key has expired")  # BE-16, despite authorizer caching
    return ctx["app_id"]


def _load_app(app_id: str) -> dict:
    app = apps_repo.get_app(app_id)
    if not app or app.get("status", "active") != "active":
        raise forbidden("app is unknown or disabled")
    return app


# ----------------------------------------------------------------- scan
def do_scan(app: dict, body: dict, rid: str, origin: str, judge_override: bool | None = None) -> dict:
    t0 = time.perf_counter()
    app_id, segments, options, metadata = parse_scan(body)
    if app_id != app["app_id"]:
        raise forbidden("app_id does not match the API key's app")
    policy = _policy_for(app, judge_override)
    result = _run_scan(segments, policy)
    total_ms = int((time.perf_counter() - t0) * 1000)
    verdict_id = ulid()
    item = build_item(
        app_id=app_id,
        verdict_id=verdict_id,
        ts_iso=_now_iso(),
        result=result,
        origin=origin,
        texts=[s.content for s in segments],
        pepper=pepper(),
        total_latency_ms=total_ms,
        metadata=metadata,
    )
    _store(item, app_id, verdict_id)
    scan_metrics(app_id, result, total_ms)
    log(
        "scan",
        request_id=rid,
        verdict_id=verdict_id,
        app_id=app_id,
        origin=origin,
        action=result["action"],
        would_action=result.get("would_action"),
        risk_score=result["risk_score"],
        latency_ms=total_ms,
        versions=result["versions"],
        degraded=result["degraded"],
    )
    out = _shape(result, options)
    out["latency_ms"] = {**out["latency_ms"], "total": total_ms}
    return {"verdict_id": verdict_id, "request_id": rid, **out}


# ----------------------------------------------------------------- chat (BE-04)
def do_chat(app: dict, body: dict, rid: str) -> dict:
    t0 = time.perf_counter()
    req = parse_chat(body)
    if req["app_id"] != app["app_id"]:
        raise forbidden("app_id does not match the API key's app")
    policy = _policy_for(app)
    input_result = _run_scan(req["segments"], policy)

    output_text = None
    output_result = None
    refusal = None
    if input_result["action"] == "block":
        refusal = REFUSAL
    else:
        canary = make_canary(secrets.token_hex(8))
        parts = [req["system"], spotlight_instructions(), canary_line(canary)]
        docs = input_result.get("sanitized", {}).get("context_docs", [])
        if docs:
            parts.append("Context documents:\n" + "\n\n".join(docs))
        system = "\n\n".join(p for p in parts if p)
        try:
            raw = call_chat(chat_model(app), system, req["messages"], req["max_tokens"], req["temperature"])
        except Exception as exc:
            log("chat model call failed", level="error", request_id=rid, app_id=app["app_id"], error_type=type(exc).__name__)
            raise ApiError(500, "INTERNAL", "the downstream model call failed") from exc
        output_result = scan_output(
            raw,
            policy,
            make_classifier(),
            canary=canary,
            allowed_domains=list(app.get("allowed_link_domains") or []),
        )
        if output_result["action"] == "block":
            refusal = REFUSAL
        else:
            output_text = output_result["sanitized"]["output"]

    actions = [input_result["action"]] + ([output_result["action"]] if output_result else [])
    action = most_severe(actions)
    total_ms = int((time.perf_counter() - t0) * 1000)
    verdict_id = ulid()

    combined = dict(input_result)
    combined["action"] = action
    if output_result:
        combined["segments"] = input_result["segments"] + output_result["segments"]
        combined["findings"] = input_result["findings"] + output_result["findings"]
        combined["risk_score"] = max(input_result["risk_score"], output_result["risk_score"])
        combined["degraded"] = input_result["degraded"] or output_result["degraded"]
        if "would_action" in input_result:
            combined["would_action"] = most_severe([input_result["would_action"], output_result.get("would_action", "allow")])
    item = build_item(
        app_id=app["app_id"],
        verdict_id=verdict_id,
        ts_iso=_now_iso(),
        result=combined,
        origin="chat",
        texts=[s.content for s in req["segments"]],
        pepper=pepper(),
        total_latency_ms=total_ms,
        metadata=req["metadata"],
    )
    _store(item, app["app_id"], verdict_id)
    scan_metrics(app["app_id"], combined, total_ms)
    log("chat", request_id=rid, verdict_id=verdict_id, app_id=app["app_id"], action=action,
        risk_score=combined["risk_score"], latency_ms=total_ms, versions=combined["versions"])
    if output_result:
        output_result = {k: v for k, v in output_result.items() if k != "sanitized"}
    return {
        "verdict_id": verdict_id,
        "request_id": rid,
        "action": action,
        "input_verdict": input_result,
        "output_verdict": output_result,
        "output": output_text,
        "refusal": refusal,
    }


# ----------------------------------------------------------------- eval (EVAL-06: never written to DynamoDB)
EVAL_CONFIGS = {"L1": (False, False), "L1+L2": (True, False), "L1+L2+L3": (True, True)}


def do_eval_scan(event: dict) -> dict:
    item = event["item"]
    use_cls, use_judge = EVAL_CONFIGS[event["config"]]
    policy = Policy.from_dict({**(event.get("policy") or {}), "judge_enabled": use_judge})
    segments = []
    if item.get("input"):
        segments.append(Segment(ref="input", source="user", content=item["input"]))
    segments.extend(parse_context_docs(item.get("context_docs")))
    t0 = time.perf_counter()
    try:
        result = scan(segments, policy, make_classifier() if use_cls else None, make_judge() if use_judge else None,
                      judge_map=_pool.map, enforce_limits=False)
    except DetectorUnavailable:
        return {"id": item.get("id"), "action": "allow", "risk": 0.0, "degraded": True, "error": "detector_unavailable"}
    latency = int((time.perf_counter() - t0) * 1000)
    judge_calls = sum(1 for s in result["segments"] if s["layers"]["judge"].get("label"))
    return {
        "id": item.get("id"),
        "label": item.get("label"),
        "category": item.get("category"),
        "action": result["action"],
        "risk": result["risk_score"],
        "latency_ms": latency,
        "layer_latency_ms": result["latency_ms"],
        "judge_calls": judge_calls,
        "degraded": result["degraded"],
        "versions": result["versions"],
    }


# ----------------------------------------------------------------- entry point
def _internal(event: dict):
    kind = event["internal"]
    if kind == "eval_scan":
        return do_eval_scan(event)
    rid = event.get("request_id", "internal")
    if kind == "playground_scan":
        try:
            app = apps_repo.get_app(event["app_id"])
            if not app:
                raise ApiError(404, "NOT_FOUND", "unknown app")
            body = dict(event.get("body") or {})
            body["app_id"] = app["app_id"]
            return response(200, do_scan(app, body, rid, "playground", event.get("judge_enabled")))
        except ApiError as err:
            return error_response(err, rid)
        except Exception as exc:
            log("playground scan failed", level="error", request_id=rid, error_type=type(exc).__name__)
            return internal_error(rid)
    raise ValueError(f"unknown internal event {kind}")


def handler(event, _context):
    if "internal" in event:
        return _internal(event)
    rid = request_id(event)
    route = event.get("routeKey", "")
    try:
        if route == "GET /healthz":
            return response(200, {"status": "ok"})
        app_id = _auth_app(event)
        body = json_body(event, MAX_BODY_BYTES)
        app = _load_app(app_id)
        if route == "POST /v1/scan":
            return response(200, do_scan(app, body, rid, "api"))
        if route == "POST /v1/chat":
            return response(200, do_chat(app, body, rid))
        raise ApiError(404, "NOT_FOUND", "unknown route")
    except ApiError as err:
        log("request rejected", level="warn", request_id=rid, route=route, status=err.status, error_code=err.code)
        return error_response(err, rid)
    except Exception as exc:
        log("unhandled error", level="error", request_id=rid, route=route, error_type=type(exc).__name__)
        return internal_error(rid)


__all__ = ["handler", "invalid"]
