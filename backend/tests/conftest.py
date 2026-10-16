from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import boto3
import pytest

ROOT = Path(__file__).resolve().parents[2]
LAMBDAS = ROOT / "backend" / "lambdas"
for p in [ROOT / "core", ROOT / "eval", LAMBDAS / "common", *[d for d in LAMBDAS.iterdir() if d.is_dir()]]:
    sys.path.insert(0, str(p))

os.environ.update(
    {
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_REGION": "us-east-1",
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "TABLE_APPS": "pif-apps",
        "TABLE_VERDICTS": "pif-verdicts",
        "TABLE_STATS": "pif-stats",
        "TABLE_EVAL_RUNS": "pif-eval-runs",
        "EVAL_BUCKET": "pif-eval-test",
        "PIF_LOCAL_PEPPER": "test-pepper",
        "PIF_XRAY": "0",
    }
)

from moto import mock_aws  # noqa: E402

from pif_core import JudgeResult  # noqa: E402


def _create_tables():
    ddb = boto3.client("dynamodb", region_name="us-east-1")
    S = "S"
    ddb.create_table(
        TableName="pif-apps",
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": n, "AttributeType": S} for n in ("app_id", "key_hash", "prev_key_hash")],
        KeySchema=[{"AttributeName": "app_id", "KeyType": "HASH"}],
        GlobalSecondaryIndexes=[
            {"IndexName": "by-key-hash", "KeySchema": [{"AttributeName": "key_hash", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}},
            {"IndexName": "by-prev-key-hash", "KeySchema": [{"AttributeName": "prev_key_hash", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}},
        ],
    )
    ddb.create_table(
        TableName="pif-verdicts",
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": n, "AttributeType": S} for n in ("pk", "sk", "verdict_id", "gsi_action_pk")],
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        GlobalSecondaryIndexes=[
            {"IndexName": "by-id", "KeySchema": [{"AttributeName": "verdict_id", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}},
            {
                "IndexName": "by-action",
                "KeySchema": [{"AttributeName": "gsi_action_pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
                "Projection": {"ProjectionType": "ALL"},
            },
        ],
    )
    ddb.create_table(
        TableName="pif-stats",
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": n, "AttributeType": S} for n in ("pk", "sk")],
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
    )
    ddb.create_table(
        TableName="pif-eval-runs",
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": "run_id", "AttributeType": S}],
        KeySchema=[{"AttributeName": "run_id", "KeyType": "HASH"}],
    )
    boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="pif-eval-test")


class MockClassifier:
    version = "mock-classifier-1"

    def __init__(self, mapping=None, default=0.02, fail=False):
        self.mapping, self.default, self.fail = mapping or {}, default, fail

    def score(self, chunks):
        if self.fail:
            raise TimeoutError("down")
        return [next((v for k, v in self.mapping.items() if k in c), self.default) for c in chunks]


class MockJudge:
    model_id = "mock-judge-1"

    def __init__(self, mapping=None):
        self.mapping = mapping or {}

    def assess(self, segment, context):
        for k, v in self.mapping.items():
            if k in segment.normalized:
                return v
        return JudgeResult("uncertain", 0.5, reason="mock")


@pytest.fixture
def aws():
    with mock_aws():
        _create_tables()
        from pif_common import apps
        from pif_common import aws as aws_mod

        aws_mod.resource.cache_clear()
        aws_mod.client.cache_clear()
        apps.clear_cache()
        yield


@pytest.fixture
def orch(aws, monkeypatch):
    import pif_orchestrator

    state = {"classifier": MockClassifier({"Ignore all previous": 0.98}), "judge": MockJudge()}
    monkeypatch.setattr(pif_orchestrator, "make_classifier", lambda: state["classifier"])
    monkeypatch.setattr(pif_orchestrator, "make_judge", lambda: state["judge"])
    pif_orchestrator.state = state
    return pif_orchestrator


@pytest.fixture
def admin(aws, monkeypatch, orch):
    import pif_admin

    def invoke(payload):
        return orch.handler(payload, None)

    monkeypatch.setattr(pif_admin, "invoke_orchestrator", invoke)
    return pif_admin


def admin_event(route: str, *, groups=("admin",), body=None, path=None, qs=None, sub="user-1") -> dict:
    return {
        "routeKey": route,
        "requestContext": {"requestId": "req-admin", "authorizer": {"jwt": {"claims": {"sub": sub, "cognito:groups": "[" + " ".join(groups) + "]"}}}},
        "pathParameters": path or {},
        "queryStringParameters": qs,
        "body": json.dumps(body) if body is not None else None,
    }


def data_event(route: str, body, *, app_id: str | None = "support-bot", status: str = "ok", raw: str | None = None) -> dict:
    return {
        "routeKey": route,
        "requestContext": {"requestId": "req-1", "authorizer": {"lambda": {"auth_status": status, "app_id": app_id or ""}}},
        "body": raw if raw is not None else json.dumps(body),
    }


def create_app(admin_mod, app_id="support-bot", **extra) -> str:
    resp = admin_mod.handler(admin_event("POST /v1/admin/apps", body={"app_id": app_id, "name": "Support bot", **extra}), None)
    assert resp["statusCode"] == 201, resp["body"]
    return json.loads(resp["body"])["api_key"]


def all_verdicts() -> list[dict]:
    return boto3.resource("dynamodb", region_name="us-east-1").Table("pif-verdicts").scan()["Items"]
