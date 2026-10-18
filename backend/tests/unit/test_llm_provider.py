"""Anthropic API provider for the judge and /v1/chat (alternative to Bedrock)."""

import json
from types import SimpleNamespace

import orch_adapters
import pytest
from orch_adapters import AnthropicJudge, anthropic_model_id

from .conftest import create_app, data_event


class FakeMessages:
    def __init__(self, reply="", error=None):
        self.reply, self.error, self.calls = reply, error, []

    def create(self, **kwargs):
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


def test_bedrock_stays_the_default(orch, monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("SSM_PREFIX", raising=False)
    assert orch.llm_provider() == "bedrock"
    monkeypatch.setenv("LLM_PROVIDER", "Anthropic")
    assert orch.llm_provider() == "anthropic"


def test_anthropic_judge_parses_and_degrades(fake_anthropic):
    seg = SimpleNamespace(normalized="hello", source="user", trust="untrusted")  # the fields assess() reads
    fake_anthropic.reply = '{"label": "injection", "confidence": 0.9, "reason": "override"}'
    result = AnthropicJudge("us.anthropic.claude-haiku-4-5-20251001-v1:0").assess(seg, None)
    assert result.label == "injection" and not result.degraded
    call = fake_anthropic.calls[0]
    assert call["model"] == "claude-haiku-4-5" and call["max_tokens"] == 300 and call["temperature"] == 0
    assert fake_anthropic.seen["retries"] == 0

    fake_anthropic.error = TimeoutError("slow")
    assert AnthropicJudge("claude-haiku-4-5").assess(seg, None).degraded
