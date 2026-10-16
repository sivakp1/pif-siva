"""Access to the pif-apps table, with the BE-12 policy cache."""

from __future__ import annotations

import os
from datetime import UTC, datetime

from boto3.dynamodb.conditions import Key

from .aws import TtlCache, from_ddb, table

POLICY_CACHE_SECONDS = float(os.environ.get("POLICY_CACHE_SECONDS", "60"))
_app_cache = TtlCache(POLICY_CACHE_SECONDS)


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def get_app(app_id: str, *, cached: bool = True) -> dict | None:
    def load():
        item = table("TABLE_APPS").get_item(Key={"app_id": app_id}).get("Item")
        return from_ddb(item) if item else None

    if not cached:
        return load()
    return _app_cache.get(app_id, load)


def clear_cache() -> None:
    _app_cache.clear()


def find_by_key_hash(h: str) -> tuple[dict | None, bool]:
    """Returns (app, is_previous_key)."""
    t = table("TABLE_APPS")
    items = t.query(IndexName="by-key-hash", KeyConditionExpression=Key("key_hash").eq(h), Limit=1).get("Items", [])
    if items:
        return from_ddb(items[0]), False
    items = t.query(IndexName="by-prev-key-hash", KeyConditionExpression=Key("prev_key_hash").eq(h), Limit=1).get("Items", [])
    if items:
        return from_ddb(items[0]), True
    return None, False


def public_view(app: dict) -> dict:
    """App fields safe to return to the dashboard (no key hashes)."""
    policy = app.get("policy") or {}
    return {
        "app_id": app["app_id"],
        "name": app.get("name", ""),
        "status": app.get("status", "active"),
        "key_prefix": app.get("key_prefix"),
        "mode": policy.get("mode", "enforce"),
        "policy_version": app.get("policy_version", 0),
        "allowed_link_domains": sorted(app.get("allowed_link_domains") or []),
        "chat_model_id": app.get("chat_model_id"),
        "prev_key_expires_at": app.get("prev_key_expires_at"),
        "created_at": app.get("created_at"),
        "updated_at": app.get("updated_at"),
        "updated_by": app.get("updated_by"),
    }
