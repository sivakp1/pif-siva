"""AWS implementations of the pif_core Classifier and Judge interfaces, plus the chat call."""

from __future__ import annotations

import json
import os
import secrets

from pif_common.aws import client
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
        lam = client("lambda", read_timeout=CLASSIFIER_TIMEOUT_S, retries=0)
        resp = lam.invoke(
            FunctionName=self.function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps({"chunks": chunks}).encode(),
        )
        if resp.get("FunctionError"):
            raise ClassifierError("classifier function error")
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
        br = client("bedrock-runtime", read_timeout=JUDGE_TIMEOUT_S, retries=0)
        resp = br.converse(
            modelId=self.model_id,
            system=[{"text": system}],
            messages=[{"role": "user", "content": [{"text": user}]}],
            inferenceConfig={"temperature": 0, "maxTokens": 300},
        )
        return "".join(part.get("text", "") for part in resp["output"]["message"]["content"])

    def assess(self, segment, context):
        nonce = secrets.token_hex(8)
        return run_judge(self._call, segment.normalized, segment.source, segment.trust, nonce)


def chat_completion(model_id: str, system: str, messages: list[dict], max_tokens: int, temperature: float) -> str:
    br = client("bedrock-runtime", read_timeout=CHAT_TIMEOUT_S, retries=1)
    resp = br.converse(
        modelId=model_id,
        system=[{"text": system}],
        messages=[{"role": m["role"], "content": [{"text": m["content"]}]} for m in messages],
        inferenceConfig={"temperature": temperature, "maxTokens": max_tokens},
    )
    return "".join(part.get("text", "") for part in resp["output"]["message"]["content"])
