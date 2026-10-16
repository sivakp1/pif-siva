"""BE-01 / BE-16: data-plane API-key authorizer (HTTP API, simple responses).

HTTP APIs cannot customize authorizer failure bodies, so the authorizer always
authorizes and passes `auth_status` in the context. The orchestrator turns a
bad status into the BE-05 envelope (401). Results are cached by API Gateway for
300 s per key, so an expired previous key is also re-checked in the handler via
`prev_expires_at`.
"""

from __future__ import annotations

from datetime import UTC, datetime

from pif_common.apps import find_by_key_hash
from pif_common.ids import KEY_PREFIX, key_hash
from pif_common.obs import log


def _header(event: dict, name: str) -> str:
    headers = event.get("headers") or {}
    for k, v in headers.items():
        if k.lower() == name:
            return v or ""
    return ""


def _deny(status: str) -> dict:
    return {"isAuthorized": True, "context": {"auth_status": status, "app_id": ""}}


def handler(event, _context):
    key = _header(event, "x-api-key").strip()
    if not key.startswith(KEY_PREFIX) or len(key) != len(KEY_PREFIX) + 32:
        return _deny("invalid_key")
    try:
        app, is_prev = find_by_key_hash(key_hash(key))
    except Exception as exc:  # never leak details
        log("authorizer lookup failed", level="error", error_type=type(exc).__name__)
        return _deny("lookup_error")
    if app is None:
        return _deny("invalid_key")
    if app.get("status", "active") != "active":
        return _deny("app_disabled")
    prev_expires = ""
    if is_prev:
        prev_expires = app.get("prev_key_expires_at") or ""
        if not prev_expires or datetime.fromisoformat(prev_expires.replace("Z", "+00:00")) <= datetime.now(UTC):
            return _deny("key_expired")
    return {
        "isAuthorized": True,
        "context": {"auth_status": "ok", "app_id": app["app_id"], "prev_expires_at": prev_expires},
    }
