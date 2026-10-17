"""BE-05 error envelope and HTTP helpers for API Gateway HTTP API (payload v2)."""

from __future__ import annotations

import base64
import json
from decimal import Decimal


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}


def invalid(message: str) -> ApiError:
    return ApiError(400, "INVALID_REQUEST", message)


def unauthorized(message: str = "missing or invalid credentials") -> ApiError:
    return ApiError(401, "UNAUTHORIZED", message)


def forbidden(message: str = "not permitted") -> ApiError:
    return ApiError(403, "FORBIDDEN", message)


def not_found(message: str) -> ApiError:
    return ApiError(404, "NOT_FOUND", message)


def conflict(message: str) -> ApiError:
    return ApiError(409, "CONFLICT", message)


def too_large(message: str) -> ApiError:
    return ApiError(413, "PAYLOAD_TOO_LARGE", message)


def rate_limited(retry_after: int) -> ApiError:
    return ApiError(429, "RATE_LIMITED", f"rate limit reached; retry after {retry_after} s", {"Retry-After": str(retry_after)})


def unavailable(message: str = "detector unavailable") -> ApiError:
    return ApiError(503, "DETECTOR_UNAVAILABLE", message)


def _default(o):
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    if isinstance(o, set | frozenset):
        return sorted(o)
    raise TypeError(f"not serializable: {type(o).__name__}")


def dumps(obj) -> str:
    return json.dumps(obj, default=_default, ensure_ascii=False, separators=(",", ":"))


def response(status: int, body, headers: dict | None = None) -> dict:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store", **(headers or {})},
        "body": dumps(body),
    }


def error_response(err: ApiError, request_id: str) -> dict:
    return response(
        err.status,
        {"error": {"code": err.code, "message": err.message, "request_id": request_id}},
        err.headers,
    )


def internal_error(request_id: str) -> dict:
    return error_response(ApiError(500, "INTERNAL", "internal error"), request_id)


def request_id(event: dict) -> str:
    return (event.get("requestContext") or {}).get("requestId") or event.get("request_id") or "local"


def raw_body(event: dict) -> str:
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8", errors="replace")
    return body


def json_body(event: dict, max_bytes: int | None = None) -> dict:
    body = raw_body(event)
    if max_bytes is not None and len(body.encode("utf-8")) > max_bytes:
        raise too_large(f"request body exceeds {max_bytes // 1024} KB")
    if not body:
        raise invalid("request body is required")
    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise invalid(f"request body is not valid JSON ({exc.msg})") from exc
    if not isinstance(data, dict):
        raise invalid("request body must be a JSON object")
    return data
