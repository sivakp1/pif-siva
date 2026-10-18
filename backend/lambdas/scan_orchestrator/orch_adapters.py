"""AWS implementations of the pif_core Classifier and Judge interfaces, plus the chat call."""

from __future__ import annotations

import json
import os
import re
import secrets
from functools import cache

from pif_common.aws import anthropic_api_key, client, gemini_api_key, ssm_param
from pif_common.obs import log
from pif_core.errors import ClassifierError
from pif_core.judge_prompt import run_judge

JUDGE_TIMEOUT_S = float(os.environ.get("JUDGE_TIMEOUT_MS", "2500")) / 1000
CLASSIFIER_TIMEOUT_S = float(os.environ.get("CLASSIFIER_TIMEOUT_MS", "800")) / 1000
CHAT_TIMEOUT_S = float(os.environ.get("CHAT_TIMEOUT_MS", "6000")) / 1000


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
        return _anthropic_text(model_id, system, messages, max_tokens, temperature, CHAT_TIMEOUT_S, 1)
    except Exception as exc:
        _log_error("chat call failed", exc)
        raise


# ----------------------------------------------------------------- Gemini API (Google AI Studio key)
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
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
    # deadline at that minimum while the client still gives up after `timeout` (2.5 s judge, 6 s chat).
    options = types.HttpOptions(timeout=int(timeout * 1000), headers={"X-Server-Timeout": str(GEMINI_SERVER_DEADLINE_S)})
    return genai.Client(api_key=api_key, http_options=options)


def _gemini_config(model: str, system: str, max_tokens: int, temperature: float):
    from google.genai import types

    cfg = {"system_instruction": system, "max_output_tokens": max_tokens}
    if model.startswith("gemini-2.5-flash"):
        # Thinking would add latency and spend the output budget; Flash and Flash-Lite allow turning it off
        cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        cfg["temperature"] = temperature
    elif model.startswith("gemini-3"):
        # Gemini 3 cannot turn thinking off and is tuned for the default temperature; keep thinking low and
        # leave room for it in the output budget
        cfg["thinking_config"] = types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW)
        cfg["max_output_tokens"] = max_tokens + 2048
    else:
        cfg["temperature"] = temperature
    return types.GenerateContentConfig(**cfg)


def _gemini_text(model_id: str, system: str, messages: list[dict], max_tokens: int, temperature: float, timeout: float) -> str:
    from google.genai import types

    model = gemini_model_id(model_id)
    contents = [
        types.Content(role="model" if m["role"] == "assistant" else "user", parts=[types.Part(text=m["content"])]) for m in messages
    ]
    resp = _gemini_client(gemini_api_key(), timeout).models.generate_content(
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
        return _gemini_text(model_id, system, messages, max_tokens, temperature, CHAT_TIMEOUT_S)
    except Exception as exc:
        _log_error("chat call failed", exc)
        raise


def _log_error(msg: str, exc: Exception) -> None:
    """Error type and AWS error message only; never the scanned text (P1, BE-18)."""
    resp = getattr(exc, "response", None)  # a dict for botocore errors, an HTTP response for Anthropic SDK errors
    code = resp.get("Error", {}).get("Code") if isinstance(resp, dict) else getattr(exc, "status_code", None) or getattr(exc, "code", None)
    log(msg, level="error", error_type=f"{type(exc).__name__}:{code or ''}", error_code=str(exc)[:300])


def chat_completion(model_id: str, system: str, messages: list[dict], max_tokens: int, temperature: float) -> str:
    br = client("bedrock-runtime", read_timeout=CHAT_TIMEOUT_S, retries=1)
    resp = br.converse(
        modelId=model_id,
        system=[{"text": system}],
        messages=[{"role": m["role"], "content": [{"text": m["content"]}]} for m in messages],
        inferenceConfig={"temperature": temperature, "maxTokens": max_tokens},
    )
    return "".join(part.get("text", "") for part in resp["output"]["message"]["content"])
