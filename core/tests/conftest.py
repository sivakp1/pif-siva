from __future__ import annotations

import pytest

from pif_core import JudgeResult


class MockClassifier:
    """Returns the score of the first key found in a chunk, else default."""

    version = "mock-classifier-1"

    def __init__(self, mapping: dict[str, float] | None = None, default: float = 0.02, fail: bool = False):
        self.mapping = mapping or {}
        self.default = default
        self.fail = fail
        self.calls: list[list[str]] = []

    def score(self, chunks):
        self.calls.append(list(chunks))
        if self.fail:
            raise TimeoutError("classifier timed out")
        out = []
        for chunk in chunks:
            for key, value in self.mapping.items():
                if key in chunk:
                    out.append(value)
                    break
            else:
                out.append(self.default)
        return out


class MockJudge:
    model_id = "mock-judge-1"

    def __init__(self, mapping: dict[str, JudgeResult] | None = None, default: JudgeResult | None = None):
        self.mapping = mapping or {}
        self.default = default or JudgeResult(label="uncertain", confidence=0.5, reason="mock")
        self.calls: list[str] = []

    def assess(self, segment, context):
        self.calls.append(segment.ref)
        for key, value in self.mapping.items():
            if key in segment.normalized:
                return value
        return self.default


@pytest.fixture
def fixed_nonce():
    return "0123456789ab"
