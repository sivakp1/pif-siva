"""Lazily created AWS clients, config caches and DynamoDB type helpers."""

from __future__ import annotations

import os
import time
from decimal import Decimal
from functools import cache

import boto3
from botocore.config import Config

try:  # BE-20: Bedrock / Lambda calls appear as X-Ray subsegments
    from aws_xray_sdk.core import patch as _xray_patch

    if os.environ.get("AWS_LAMBDA_FUNCTION_NAME") and os.environ.get("PIF_XRAY", "1") == "1":
        _xray_patch(["boto3", "botocore"])
except ImportError:  # pragma: no cover - local tests
    pass

REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))


@cache
def resource(name: str):
    return boto3.resource(name, region_name=REGION)


@cache
def client(name: str, read_timeout: float | None = None, retries: int | None = None):
    cfg = {}
    if read_timeout is not None:
        cfg["read_timeout"] = read_timeout
        cfg["connect_timeout"] = min(read_timeout, 2)
    if retries is not None:
        cfg["retries"] = {"max_attempts": retries + 1, "mode": "standard"}
    return boto3.client(name, region_name=REGION, config=Config(**cfg) if cfg else None)


def table(env_name: str):
    return resource("dynamodb").Table(os.environ[env_name])


class TtlCache:
    def __init__(self, ttl_seconds: float):
        self.ttl = ttl_seconds
        self._data: dict = {}

    def get(self, key, loader, now: float | None = None):
        now = time.time() if now is None else now
        hit = self._data.get(key)
        if hit and now - hit[0] < self.ttl:
            return hit[1]
        value = loader()
        self._data[key] = (now, value)
        return value

    def clear(self):
        self._data.clear()


_secret_cache = TtlCache(300)  # BE-22: pepper cached 5 minutes
_ssm_cache = TtlCache(300)


def pepper() -> bytes:
    arn = os.environ.get("PEPPER_SECRET_ARN")
    if not arn:
        return os.environ.get("PIF_LOCAL_PEPPER", "local-dev-pepper").encode()
    return _secret_cache.get(arn, lambda: client("secretsmanager").get_secret_value(SecretId=arn)["SecretString"].encode())


def anthropic_api_key() -> str:
    """Anthropic API key from Secrets Manager (cached 5 minutes); ANTHROPIC_API_KEY for local runs."""
    arn = os.environ.get("ANTHROPIC_SECRET_ARN")
    if not arn:
        return os.environ.get("ANTHROPIC_API_KEY", "")
    return _secret_cache.get(arn, lambda: client("secretsmanager").get_secret_value(SecretId=arn)["SecretString"].strip())


def ssm_param(name: str, default: str | None = None) -> str | None:
    prefix = os.environ.get("SSM_PREFIX")
    env_override = os.environ.get(name.upper())
    if env_override:
        return env_override
    if not prefix:
        return default

    def load():
        try:
            return client("ssm").get_parameter(Name=f"{prefix}/{name}")["Parameter"]["Value"]
        except Exception:
            return default

    return _ssm_cache.get(name, load)


def to_ddb(obj):
    """Convert floats to Decimal recursively; drop None and empty sets."""
    if isinstance(obj, float):
        return Decimal(str(round(obj, 6)))
    if isinstance(obj, dict):
        return {k: to_ddb(v) for k, v in obj.items() if v is not None and v != set()}
    if isinstance(obj, list | tuple):
        return [to_ddb(v) for v in obj]
    return obj


def from_ddb(obj):
    if isinstance(obj, Decimal):
        return int(obj) if obj == obj.to_integral_value() else float(obj)
    if isinstance(obj, dict):
        return {k: from_ddb(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [from_ddb(v) for v in obj]
    if isinstance(obj, set):
        return sorted(from_ddb(v) for v in obj)
    return obj
