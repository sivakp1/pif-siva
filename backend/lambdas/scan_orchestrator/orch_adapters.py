"""AWS implementations of the pif_core Classifier and Judge interfaces, plus the chat call."""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from functools import cache

from pif_common.aws import anthropic_api_key, client, gemini_api_key, ssm_param
from pif_common.obs import log
from pif_core.errors import ClassifierError
from pif_core.judge_prompt import run_judge

JUDGE_TIMEOUT_S = float(os.environ.get("JUDGE_TIMEOUT_MS", "2500")) / 1000
CLASSIFIER_TIMEOUT_S = float(os.environ.get("CLASSIFIER_TIMEOUT_MS", "800")) / 1000
# The orchestrator Lambda runs for up to 20 s; the chat call gets most of it (capped by chat_timeout()).
CHAT_TIMEOUT_S = float(os.environ.get("CHAT_TIMEOUT_MS", "17000")) / 1000
# Time kept back after the chat model call for the output scan and storing the verdict
CHAT_RESERVE_S = float(os.environ.get("CHAT_RESERVE_MS", "1500")) / 1000
MIN_CHAT_TIMEOUT_S = 1.0
# Gemini's latency varies widely (0.7 s to 30 s for the same request in testing); when the first chat
# call hasn't answered after this long, an identical second call is started and the first answer wins.
CHAT_HEDGE_AFTER_S = float(os.environ.get("CHAT_HEDGE_AFTER_MS", "2500")) / 1000
_hedge_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="chat-hedge")

_deadline: float | None = None  # time.monotonic() at which the Lambda invocation times out


def start_request(context) -> None:
    """Record the invocation's deadline (Lambda context), so the chat call never outlives the function."""
    global _deadline
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    _deadline = time.monotonic() + remaining() / 1000 if callable(remaining) else None


def chat_timeout() -> float:
    """CHAT_TIMEOUT_S, capped by the time left in this request minus CHAT_RESERVE_S.

    Rounded down to 0.5 s so the per-timeout HTTP clients stay few.
    """
    t = CHAT_TIMEOUT_S
    if _deadline is not None:
        t = min(t, _deadline - time.monotonic() - CHAT_RESERVE_S)
    return max(MIN_CHAT_TIMEOUT_S, math.floor(t * 2) / 2)


def hedged(call, budget: float):
    """Run call(timeout_s); if it hasn't returned after CHAT_HEDGE_AFTER_S, start an identical second call.

    Returns the first successful result. A call that fails quickly (for example a 429 quota error) is raised at
    once without hedging. When every attempt fails, a rate-limit error is preferred so the caller can report
    "busy"; when none finishes within `budget`, raises TimeoutError. Unfinished attempts are abandoned (each
    has its own client timeout, so they end on their own).
    """
    start = time.monotonic()
    pending = {_hedge_pool.submit(call, budget)}
    errors: list[Exception] = []
    hedge_sent = False
    while pending:
        elapsed = time.monotonic() - start
        left = budget - elapsed
        if left <= 0:
            break
        timeout = left if hedge_sent else min(left, max(0.0, CHAT_HEDGE_AFTER_S - elapsed))
        done, pending = wait(pending, timeout=timeout, return_when=FIRST_COMPLETED)
        for f in done:
            if f.exception() is None:
                return f.result()
            errors.append(f.exception())
        if not done and not hedge_sent:
            hedge_sent = True
            remaining = budget - (time.monotonic() - start)
            if remaining >= MIN_CHAT_TIMEOUT_S:
                log("chat hedge sent", level="info", after_ms=int((time.monotonic() - start) * 1000))
                pending.add(_hedge_pool.submit(call, remaining))
    if errors:
        raise next((e for e in errors if rate_limit_retry_after(e) is not None), errors[0])
    raise TimeoutError(f"no model answer within {budget:.1f} s")


_TIMEOUT_NAMES = {"TimeoutError", "ReadTimeout", "ConnectTimeout", "WriteTimeout", "PoolTimeout", "TimeoutException",
                  "APITimeoutError", "ReadTimeoutError", "ConnectTimeoutError"}


def is_model_timeout(exc: BaseException | None) -> bool:
    """True if the model call failed by timing out (Python, httpx, Anthropic SDK or botocore timeouts)."""
    seen = 0
    while exc is not None and seen < 5:
        if isinstance(exc, TimeoutError) or type(exc).__name__ in _TIMEOUT_NAMES:
            return True
        exc, seen = exc.__cause__ or exc.__context__, seen + 1
    return False


class LambdaClassifier:
    """Invokes the classifier container synchronously with all chunks (BE-13)."""

    def __init__(self, function_name: str, version: str):
        self.function_name = function_name
        self.version = version

    def score(self, chunks: list[str]) -> list[float]:
        try:
            return self._score(chunks)
        except Exception as exc:
            _log_error("classifier call failed", exc)
            raise

    def _score(self, chunks: list[str]) -> list[float]:
        lam = client("lambda", read_timeout=CLASSIFIER_TIMEOUT_S, retries=0)
        resp = lam.invoke(
            FunctionName=self.function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps({"chunks": chunks}).encode(),
        )
        if resp.get("FunctionError"):
            err = json.loads(resp["Payload"].read() or b"{}")
            raise ClassifierError(f"classifier function error: {err.get('errorType')}: {str(err.get('errorMessage'))[:200]}")
        data = json.loads(resp["Payload"].read())
        scores = data.get("scores")
        if not isinstance(scores, list):
            raise ClassifierError("classifier returned no scores")
        if data.get("version"):
            self.version = data["version"]
        return [float(s) for s in scores]


class BedrockJudge:
    """CORE-18: Bedrock Converse, temperature 0, max 300 tokens, 2.5 s timeout."""

    def __init__(self, model_id: str):
        self.model_id = model_id

    def _call(self, system: str, user: str) -> str:
        try:
            br = client("bedrock-runtime", read_timeout=JUDGE_TIMEOUT_S, retries=0)
            resp = br.converse(
                modelId=self.model_id,
                system=[{"text": system}],
                messages=[{"role": "user", "content": [{"text": user}]}],
                inferenceConfig={"temperature": 0, "maxTokens": 300},
            )
        except Exception as exc:
            _log_error("judge call failed", exc)
            raise
        return "".join(part.get("text", "") for part in resp["output"]["message"]["content"])

    def assess(self, segment, context):
        nonce = secrets.token_hex(8)
        result = run_judge(self._call, segment.normalized, segment.source, segment.trust, nonce)
        if result.degraded:
            log("judge degraded", level="error", error_code="JUDGE_DEGRADED")
        return result


# ----------------------------------------------------------------- Anthropic API (alternative to Bedrock)
# Bedrock IDs such as "us.anthropic.claude-haiku-4-5-20251001-v1:0" name the same models as the
# Anthropic API's "claude-haiku-4-5", so app and SSM model settings work with either provider.
_BEDROCK_ID = re.compile(r"^(?:[a-z]+\.)?anthropic\.(claude-[a-z0-9-]+?)(?:-\d{8})?(?:-v\d+(?::\d+)?)?$")


def anthropic_model_id(model_id: str) -> str:
    m = _BEDROCK_ID.match(model_id)
    return m.group(1) if m else model_id


@cache
def _anthropic_client(api_key: str, timeout: float, retries: int):
    import anthropic  # imported lazily: only the Anthropic provider needs it

    return anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=retries)


# Claude 3.x and Claude 4.0-4.6 models take a sampling temperature; newer ones (Opus 4.7+, the 5.x
# family) reject it. The 1.x SDK has no temperature argument, so it goes in extra_body.
_ACCEPTS_TEMPERATURE = re.compile(r"^claude-(?:3|(?:haiku|sonnet|opus)-4(?:-[0-6])?(?:-\d{8})?$)")


def _anthropic_text(model_id: str, system: str, messages: list[dict], max_tokens: int, temperature: float, timeout: float, retries: int) -> str:
    model = anthropic_model_id(model_id)
    resp = _anthropic_client(anthropic_api_key(), timeout, retries).messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": m["role"], "content": m["content"]} for m in messages],
        **({"extra_body": {"temperature": temperature}} if _ACCEPTS_TEMPERATURE.match(model) else {}),
    )
    return "".join(block.text for block in resp.content if block.type == "text")


class AnthropicJudge:
    """CORE-18 via the Anthropic API: same prompt, temperature 0, max 300 tokens, 2.5 s timeout."""

    def __init__(self, model_id: str):
        self.model_id = model_id

    def _call(self, system: str, user: str) -> str:
        try:
            return _anthropic_text(self.model_id, system, [{"role": "user", "content": user}], 300, 0, JUDGE_TIMEOUT_S, 0)
        except Exception as exc:
            _log_error("judge call failed", exc)
            raise

    def assess(self, segment, context):
        nonce = secrets.token_hex(8)
        result = run_judge(self._call, segment.normalized, segment.source, segment.trust, nonce)
        if result.degraded:
            log("judge degraded", level="error", error_code="JUDGE_DEGRADED")
        return result


def anthropic_chat_completion(model_id: str, system: str, messages: list[dict], max_tokens: int, temperature: float) -> str:
    try:
        return _anthropic_text(model_id, system, messages, max_tokens, temperature, chat_timeout(), 0)
    except Exception as exc:
        _log_error("chat call failed", exc)
        raise


# ----------------------------------------------------------------- Gemini API (Google AI Studio key)
# gemini-2.5-flash is closed to new API projects; 3.5 Flash-Lite answered the judge prompt in about 0.7 s,
# well inside the judge's 2.5 s budget (3.8 Flash took about 4.4 s at the lowest thinking level it allows).
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
GEMINI_SERVER_DEADLINE_S = 10  # the smallest deadline the Gemini API accepts


def gemini_model_id(model_id: str) -> str:
    """App and SSM model settings name Claude models; Gemini uses its own setting unless a Gemini ID is given."""
    if model_id.startswith("gemini-"):
        return model_id
    return ssm_param("gemini_model_id", DEFAULT_GEMINI_MODEL) or DEFAULT_GEMINI_MODEL


@cache
def _gemini_client(api_key: str, timeout: float):
    from google import genai  # imported lazily: only the Gemini provider needs it
    from google.genai import types

    # The SDK sends `timeout` to Google as the server deadline too, and the Gemini API rejects deadlines
    # under 10 s ("Minimum allowed deadline is 10s"). Setting the header ourselves keeps the server
    # deadline at least that long while the client still gives up after `timeout` (2.5 s judge, up to 17 s chat).
    deadline = max(GEMINI_SERVER_DEADLINE_S, math.ceil(timeout))
    options = types.HttpOptions(timeout=int(timeout * 1000), headers={"X-Server-Timeout": str(deadline)})
    return genai.Client(api_key=api_key, http_options=options)


def _gemini_config(model: str, system: str, max_tokens: int, temperature: float):
    from google.genai import types

    cfg = {"system_instruction": system, "max_output_tokens": max_tokens}
    if model.startswith("gemini-2.5-flash"):
        # Thinking would add latency and spend the output budget; Flash and Flash-Lite allow turning it off
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        cfg["temperature"] = temperature
    elif model.startswith("gemini-3"):
        # Gemini 3 cannot turn thinking off and is tuned for the default temperature. Flash-Lite accepts the
        # MINIMAL level (about 0.6 s for the judge prompt; LOW sometimes ran past the old 6 s chat limit);
        # other Gemini 3 models reject MINIMAL, so they keep LOW. Leave room for thinking in the output budget.
        level = types.ThinkingLevel.MINIMAL if "flash-lite" in model else types.ThinkingLevel.LOW
        cfg["thinking_config"] = types.ThinkingConfig(thinking_level=level)
        cfg["max_output_tokens"] = max_tokens + 2048
    else:
        cfg["temperature"] = temperature
    return types.GenerateContentConfig(**cfg)


def _gemini_text(model_id: str, system: str, messages: list[dict], max_tokens: int, temperature: float, timeout: float) -> str:
    return _gemini_generate(gemini_api_key(), gemini_model_id(model_id), system, messages, max_tokens, temperature, timeout)


def _gemini_generate(api_key: str, model: str, system: str, messages: list[dict], max_tokens: int, temperature: float,
                     timeout: float) -> str:
    """One Gemini call. Safe to run in a worker thread (the key and model are resolved by the caller)."""
    from google.genai import types

    timeout = max(MIN_CHAT_TIMEOUT_S, math.floor(timeout * 2) / 2)  # half-second steps keep the cached clients few
    contents = [
        types.Content(role="model" if m["role"] == "assistant" else "user", parts=[types.Part(text=m["content"])]) for m in messages
    ]
    resp = _gemini_client(api_key, timeout).models.generate_content(
        model=model, contents=contents, config=_gemini_config(model, system, max_tokens, temperature)
    )
    text = resp.text
    if not text:  # e.g. a safety block or an empty candidate
        reason = resp.candidates[0].finish_reason if resp.candidates else getattr(resp.prompt_feedback, "block_reason", None)
        raise RuntimeError(f"Gemini returned no text (finish/block reason: {reason})")
    return text


class GeminiJudge:
    """CORE-18 via the Gemini API: same prompt, max 300 output tokens, 2.5 s timeout."""

    def __init__(self, model_id: str):
        self.model_id = gemini_model_id(model_id)  # recorded in verdicts as the judge version

    def _call(self, system: str, user: str) -> str:
        try:
            return _gemini_text(self.model_id, system, [{"role": "user", "content": user}], 300, 0, JUDGE_TIMEOUT_S)
        except Exception as exc:
            _log_error("judge call failed", exc)
            raise

    def assess(self, segment, context):
        nonce = secrets.token_hex(8)
        result = run_judge(self._call, segment.normalized, segment.source, segment.trust, nonce)
        if result.degraded:
            log("judge degraded", level="error", error_code="JUDGE_DEGRADED")
        return result


def gemini_chat_completion(model_id: str, system: str, messages: list[dict], max_tokens: int, temperature: float) -> str:
    try:
        key, model = gemini_api_key(), gemini_model_id(model_id)
        return hedged(lambda t: _gemini_generate(key, model, system, messages, max_tokens, temperature, t), chat_timeout())
    except Exception as exc:
        _log_error("chat call failed", exc)
        raise


# ----------------------------------------------------------------- provider rate limits
DEFAULT_RETRY_AFTER_S = 20
MAX_RETRY_AFTER_S = 60
_THROTTLE_CODES = {"ThrottlingException", "TooManyRequestsException"}  # Bedrock
_DELAY = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*s?\s*$")


def _seconds(value) -> int | None:
    m = _DELAY.match(str(value)) if value is not None else None
    return min(max(math.ceil(float(m.group(1))), 1), MAX_RETRY_AFTER_S) if m else None


def rate_limit_retry_after(exc: Exception) -> int | None:
    """Seconds to wait if `exc` is a provider rate limit, else None.

    Gemini: google.genai ClientError with code 429 (RESOURCE_EXHAUSTED) and a RetryInfo retryDelay such as "17s".
    Anthropic: RateLimitError (status 429) with a retry-after header. Bedrock: ThrottlingException.
    """
    resp = getattr(exc, "response", None)
    if isinstance(resp, dict):  # botocore
        return DEFAULT_RETRY_AFTER_S if resp.get("Error", {}).get("Code") in _THROTTLE_CODES else None
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if status != 429:
        return None
    details = getattr(exc, "details", None)  # Gemini: the error JSON
    err = details.get("error", details) if isinstance(details, dict) else None
    infos = err.get("details") if isinstance(err, dict) else None
    for d in infos if isinstance(infos, list) else []:
        if isinstance(d, dict) and str(d.get("@type", "")).endswith("RetryInfo") and (s := _seconds(d.get("retryDelay"))):
            return s
    headers = getattr(resp, "headers", None)  # Anthropic: the HTTP response
    return (_seconds(headers.get("retry-after")) if headers is not None else None) or DEFAULT_RETRY_AFTER_S


def _log_error(msg: str, exc: Exception) -> None:
    """Error type and AWS error message only; never the scanned text (P1, BE-18)."""
    resp = getattr(exc, "response", None)  # a dict for botocore errors, an HTTP response for Anthropic SDK errors
    code = resp.get("Error", {}).get("Code") if isinstance(resp, dict) else getattr(exc, "status_code", None) or getattr(exc, "code", None)
    log(msg, level="error", error_type=f"{type(exc).__name__}:{code or ''}", error_code=str(exc)[:300])


def chat_completion(model_id: str, system: str, messages: list[dict], max_tokens: int, temperature: float) -> str:
    br = client("bedrock-runtime", read_timeout=chat_timeout(), retries=0)
    resp = br.converse(
        modelId=model_id,
        system=[{"text": system}],
        messages=[{"role": m["role"], "content": [{"text": m["content"]}]} for m in messages],
        inferenceConfig={"temperature": temperature, "maxTokens": max_tokens},
    )
    return "".join(part.get("text", "") for part in resp["output"]["message"]["content"])
