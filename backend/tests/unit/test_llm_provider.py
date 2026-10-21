"""Anthropic API and Gemini API providers for the judge and /v1/chat (alternatives to Bedrock)."""

import json
from types import SimpleNamespace

import orch_adapters
import pytest
from orch_adapters import AnthropicJudge, anthropic_model_id

from .conftest import create_app, data_event


class FakeMessages:
    def __init__(self, reply="", error=None):
        self.reply, self.error, self.calls = reply, error, []

    def create(self, *, model, max_tokens, messages, system=None, extra_body=None):
        # Mirrors anthropic 1.x: there is no temperature keyword (it raised TypeError in prod)
        kwargs = {"model": model, "max_tokens": max_tokens, "messages": messages, "system": system, "extra_body": extra_body}
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(content=[SimpleNamespace(type="thinking"), SimpleNamespace(type="text", text=self.reply)])


@pytest.fixture
def fake_anthropic(monkeypatch):
    fake = FakeMessages()
    seen = {}

    def make_client(api_key, timeout, retries):
        seen.update(api_key=api_key, timeout=timeout, retries=retries)
        return SimpleNamespace(messages=fake)

    monkeypatch.setattr(orch_adapters, "_anthropic_client", make_client)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    fake.seen = seen
    return fake


@pytest.mark.parametrize(
    ("model_id", "expected"),
    [
        ("us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
        ("anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"),
        ("global.anthropic.claude-opus-4-8", "claude-opus-4-8"),
        ("claude-haiku-4-5", "claude-haiku-4-5"),
    ],
)
def test_bedrock_ids_map_to_anthropic_ids(model_id, expected):
    assert anthropic_model_id(model_id) == expected


@pytest.mark.parametrize(
    ("model", "accepts"),
    [
        ("claude-haiku-4-5", True),
        ("claude-sonnet-4-6", True),
        ("claude-opus-4-1-20250805", True),
        ("claude-3-5-haiku-20241022", True),
        ("claude-opus-4-7", False),
        ("claude-opus-4-8", False),
        ("claude-haiku-5-5", False),
        ("claude-opus-5-5", False),
    ],
)
def test_temperature_only_for_models_that_accept_it(model, accepts):
    assert bool(orch_adapters._ACCEPTS_TEMPERATURE.match(model)) is accepts


def test_chat_uses_anthropic_api_when_selected(admin, orch, monkeypatch, fake_anthropic):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")  # same override ssm_param() reads for llm_provider
    create_app(admin, chat_model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0")
    fake_anthropic.reply = "Your order ships tomorrow."
    body = {"app_id": "support-bot", "system": "You are ShopKart support.", "messages": [{"role": "user", "content": "Where is my order?"}]}
    out = json.loads(orch.handler(data_event("POST /v1/chat", body), None)["body"])
    assert out["action"] == "allow" and out["output"] == "Your order ships tomorrow."
    call = fake_anthropic.calls[0]
    assert call["model"] == "claude-haiku-4-5"
    assert call["messages"] == [{"role": "user", "content": "Where is my order?"}]
    assert "ShopKart support" in call["system"]
    assert fake_anthropic.seen["api_key"] == "sk-ant-test"


@pytest.mark.parametrize(
    "stored",
    ["sk-ant-abc\n", '"sk-ant-abc"', '{"ANTHROPIC_API_KEY": "sk-ant-abc"}', '{"note": "prod", "key": " sk-ant-abc "}'],
)
def test_secret_accepts_plain_text_and_console_key_value(stored):
    from pif_common.aws import _plain_key

    assert _plain_key(stored) == "sk-ant-abc"


class FakeGeminiModels:
    def __init__(self, reply="ok"):
        self.reply, self.calls = reply, []

    def generate_content(self, *, model, contents, config=None):  # google-genai 2.x signature
        self.calls.append({"model": model, "contents": contents, "config": config})
        return SimpleNamespace(text=self.reply, candidates=[SimpleNamespace(finish_reason="SAFETY")], prompt_feedback=None)


@pytest.fixture
def fake_gemini(monkeypatch):
    fake = FakeGeminiModels()
    seen = {}

    def make_client(api_key, timeout):
        seen.update(api_key=api_key, timeout=timeout)
        return SimpleNamespace(models=fake)

    monkeypatch.setattr(orch_adapters, "_gemini_client", make_client)
    monkeypatch.setenv("GEMINI_API_KEY", "AIza-test")
    monkeypatch.delenv("GEMINI_MODEL_ID", raising=False)
    fake.seen = seen
    return fake


def test_chat_uses_gemini_when_selected(admin, orch, monkeypatch, fake_gemini):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    create_app(admin, chat_model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0")
    fake_gemini.reply = "Your order ships tomorrow."
    msgs = [
        {"role": "user", "content": "Hi"},
        {"role": "assistant", "content": "Hello! How can I help?"},
        {"role": "user", "content": "Where is my order?"},
    ]
    body = {"app_id": "support-bot", "system": "You are ShopKart support.", "messages": msgs}
    out = json.loads(orch.handler(data_event("POST /v1/chat", body), None)["body"])
    assert out["action"] == "allow" and out["output"] == "Your order ships tomorrow."
    call = fake_gemini.calls[0]
    assert call["model"] == "gemini-3.5-flash-lite"  # Claude model settings fall back to the Gemini default
    assert [(c.role, c.parts[0].text) for c in call["contents"]] == [("user", "Hi"), ("model", "Hello! How can I help?"), ("user", "Where is my order?")]
    cfg = call["config"]
    # Flash-Lite gets the MINIMAL thinking level (LOW sometimes ran past the chat time limit)
    assert "ShopKart support" in cfg.system_instruction and cfg.thinking_config.thinking_level.value == "MINIMAL"
    assert fake_gemini.seen["api_key"] == "AIza-test"
    assert fake_gemini.seen["timeout"] == 8.0  # no Lambda context in tests, so the full chat limit applies


def test_chat_timeout_is_capped_by_the_time_left_in_the_invocation(monkeypatch):
    def ctx(ms):
        return SimpleNamespace(get_remaining_time_in_millis=lambda: ms)

    orch_adapters.start_request(ctx(9_900))  # a fresh 10 s invocation: the full 8 s limit fits
    assert orch_adapters.chat_timeout() == 8.0
    orch_adapters.start_request(ctx(6_200))  # the judge etc. used ~3.8 s: 6.2 - 1.5 reserve, rounded down to 0.5 s
    assert orch_adapters.chat_timeout() == 4.5
    orch_adapters.start_request(ctx(1_800))  # almost out of time: never below the 1 s floor
    assert orch_adapters.chat_timeout() == 1.0
    orch_adapters.start_request(None)  # local runs and tests have no context: the configured limit
    assert orch_adapters.chat_timeout() == 8.0


def test_gemini_judge_model_setting_and_gemini_3_config(fake_gemini, monkeypatch):
    seg = SimpleNamespace(normalized="hello", source="user", trust="untrusted")
    monkeypatch.setenv("GEMINI_MODEL_ID", "gemini-3.5-flash")
    fake_gemini.reply = '{"label": "benign", "confidence": 0.95, "reason": "greeting"}'
    judge = orch_adapters.GeminiJudge("us.anthropic.claude-haiku-4-5-20251001-v1:0")
    assert judge.model_id == "gemini-3.5-flash"  # reported as the judge version in verdicts
    result = judge.assess(seg, None)
    assert result.label == "benign" and not result.degraded
    cfg = fake_gemini.calls[0]["config"]
    # Non-Lite Gemini 3 models reject MINIMAL, so they keep LOW
    assert cfg.thinking_config.thinking_level.value == "LOW" and cfg.temperature is None
    assert cfg.max_output_tokens == 300 + 2048


def test_gemini_empty_reply_fails_the_chat(admin, orch, monkeypatch, fake_gemini):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    create_app(admin)
    fake_gemini.reply = None  # e.g. blocked by a Gemini safety filter
    body = {"app_id": "support-bot", "system": "s", "messages": [{"role": "user", "content": "Where is my order?"}]}
    assert orch.handler(data_event("POST /v1/chat", body), None)["statusCode"] == 500


def test_gemini_request_keeps_short_client_timeout_and_10s_server_deadline(monkeypatch):
    """Real SDK, intercepted transport: Gemini rejects server deadlines under 10 s (seen in prod)."""
    import httpx

    seen = {}

    def handle(request):
        seen["headers"], seen["timeout"] = request.headers, request.extensions.get("timeout", {})
        body = {"candidates": [{"content": {"role": "model", "parts": [{"text": "Your order ships tomorrow."}]}, "finishReason": "STOP"}]}
        return httpx.Response(200, json=body)

    real_client = httpx.Client.__init__

    def with_mock_transport(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handle)
        real_client(self, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "__init__", with_mock_transport)
    monkeypatch.setenv("GEMINI_API_KEY", "AIza-transport-test")
    monkeypatch.delenv("GEMINI_MODEL_ID", raising=False)
    orch_adapters._gemini_client.cache_clear()
    try:
        out = orch_adapters._gemini_text("gemini-2.5-flash", "sys", [{"role": "user", "content": "hi"}], 50, 0.3, 2.5)
    finally:
        orch_adapters._gemini_client.cache_clear()
    assert out == "Your order ships tomorrow."
    assert seen["headers"]["x-server-timeout"] == "10"
    assert seen["headers"]["x-goog-api-key"] == "AIza-transport-test"
    assert seen["timeout"]["read"] == 2.5  # the client still gives up after the judge/chat limit


def _gemini_429(retry_delay="17s"):
    from google.genai import errors

    info = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry_delay}] if retry_delay else []
    body = {"error": {"code": 429, "message": "You exceeded your current quota.", "status": "RESOURCE_EXHAUSTED", "details": info}}
    return errors.ClientError(429, body)


def _anthropic_429(retry_after=None):
    import anthropic
    import httpx2

    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    headers = {"retry-after": retry_after} if retry_after else {}
    body = {"type": "error", "error": {"type": "rate_limit_error", "message": "rate limited"}}
    return anthropic.RateLimitError("rate limited", response=httpx2.Response(429, headers=headers, request=req), body=body)


def _gemini_400():
    from google.genai import errors

    return errors.ClientError(400, {"error": {"code": 400, "message": "bad", "status": "INVALID_ARGUMENT"}})


def _bedrock_error(code):
    from botocore.exceptions import ClientError

    return ClientError({"Error": {"Code": code, "Message": "x"}}, "Converse")


@pytest.mark.parametrize(
    ("make", "expected"),
    [
        (lambda: _gemini_429("17s"), 17),
        (lambda: _gemini_429("2.4s"), 3),
        (lambda: _gemini_429("600s"), 60),  # capped
        (lambda: _gemini_429(None), 20),
        (lambda: _anthropic_429("7"), 7),
        (lambda: _anthropic_429(), 20),
        (lambda: _bedrock_error("ThrottlingException"), 20),
        (lambda: _bedrock_error("ValidationException"), None),
        (lambda: _gemini_400(), None),
        (lambda: TimeoutError("slow"), None),
    ],
)
def test_provider_rate_limits_are_recognised(make, expected):
    assert orch_adapters.rate_limit_retry_after(make()) == expected


def test_chat_rate_limit_returns_429_with_retry_after(admin, orch, monkeypatch, fake_gemini):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    create_app(admin)

    def busy(**_kwargs):
        raise _gemini_429("12s")

    monkeypatch.setattr(fake_gemini, "generate_content", busy)
    body = {"app_id": "support-bot", "system": "s", "messages": [{"role": "user", "content": "Can I pay with UPI?"}]}
    resp = orch.handler(data_event("POST /v1/chat", body), None)
    assert resp["statusCode"] == 429
    assert resp["headers"]["Retry-After"] == "12"
    assert json.loads(resp["body"])["error"]["code"] == "RATE_LIMITED"


def test_gemini_key_from_console_key_value():
    from pif_common.aws import _plain_key

    assert _plain_key('{"GEMINI_API_KEY": "AIzaSyTest"}', "AIza") == "AIzaSyTest"


def test_bedrock_stays_the_default(orch, monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("SSM_PREFIX", raising=False)
    assert orch.llm_provider() == "bedrock"
    monkeypatch.setenv("LLM_PROVIDER", "Anthropic")
    assert orch.llm_provider() == "anthropic"
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    assert orch.llm_provider() == "gemini"
    monkeypatch.setenv("LLM_PROVIDER", "openai")  # unknown names fall back to Bedrock
    assert orch.llm_provider() == "bedrock"


def test_anthropic_judge_parses_and_degrades(fake_anthropic):
    seg = SimpleNamespace(normalized="hello", source="user", trust="untrusted")  # the fields assess() reads
    fake_anthropic.reply = '{"label": "injection", "confidence": 0.9, "reason": "override"}'
    result = AnthropicJudge("us.anthropic.claude-haiku-4-5-20251001-v1:0").assess(seg, None)
    assert result.label == "injection" and not result.degraded
    call = fake_anthropic.calls[0]
    assert call["model"] == "claude-haiku-4-5" and call["max_tokens"] == 300 and call["extra_body"] == {"temperature": 0}
    assert fake_anthropic.seen["retries"] == 0

    AnthropicJudge("claude-opus-5-5").assess(seg, None)  # sampling settings are rejected by newer models
    assert fake_anthropic.calls[-1]["extra_body"] is None

    fake_anthropic.error = TimeoutError("slow")
    assert AnthropicJudge("claude-haiku-4-5").assess(seg, None).degraded


def test_sdk_status_errors_are_logged_not_crashed(fake_anthropic, capsys):
    import anthropic
    import httpx2

    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    body = {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}
    fake_anthropic.error = anthropic.AuthenticationError("invalid x-api-key", response=httpx2.Response(401, request=req), body=body)
    with pytest.raises(anthropic.AuthenticationError):  # the real error reaches the caller, not an AttributeError
        orch_adapters.anthropic_chat_completion("claude-haiku-4-5", "sys", [{"role": "user", "content": "hi"}], 50, 0.3)
    assert "AuthenticationError:401" in capsys.readouterr().out
