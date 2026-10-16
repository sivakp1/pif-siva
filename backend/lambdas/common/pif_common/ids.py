"""ULIDs, API keys and hashing."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import string
import time

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_KEY_ALPHABET = string.ascii_letters + string.digits
KEY_PREFIX = "pif_live_"
KEY_DISPLAY_CHARS = 12


def ulid(ts_ms: int | None = None) -> str:
    ts = int(time.time() * 1000) if ts_ms is None else ts_ms
    value = (ts << 80) | int.from_bytes(os.urandom(10), "big")
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(out))


def new_api_key() -> str:
    return KEY_PREFIX + "".join(secrets.choice(_KEY_ALPHABET) for _ in range(32))


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def key_prefix(key: str) -> str:
    return key[:KEY_DISPLAY_CHARS]


def hmac_hex(pepper: bytes, value: str) -> str:
    return hmac.new(pepper, value.encode("utf-8"), hashlib.sha256).hexdigest()
