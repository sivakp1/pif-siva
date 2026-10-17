"""admin-api: every /v1/admin/* route (control plane, Cognito JWT, BE-02)."""

from __future__ import annotations

import base64
import json
import os
import re
import time
from datetime import UTC, datetime, timedelta

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from pif_common import apps as apps_repo
from pif_common.aws import client, from_ddb, table, to_ddb
from pif_common.http import (
    ApiError,
    conflict,
    error_response,
    forbidden,
    internal_error,
    invalid,
    json_body,
    not_found,
    rate_limited,
    request_id,
)
from pif_common.http import response as _raw_response
from pif_common.ids import key_hash, key_prefix, new_api_key, ulid
from pif_common.obs import log
from pif_common.stats import COUNTERS, LAT_EDGES, percentile
from pif_core import PolicyError, validate_policy

KEY_GRACE_HOURS = float(os.environ.get("KEY_GRACE_HOURS", "24"))
PLAYGROUND_PER_MINUTE = int(os.environ.get("PLAYGROUND_PER_MINUTE", "30"))
EVAL_CONFIGS = ("L1", "L1+L2", "L1+L2+L3", "bedrock_guardrails")
APP_ID_RE = re.compile(r"^[a-z0-9-]{3,40}$")
DOMAIN_RE = re.compile(r"^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$")
ACTIONS = ("allow", "flag", "sanitize", "block")
ORIGINS = ("api", "chat", "playground")
MAX_PAGE = 100


def _clean(obj):
    """Drop None values recursively: the dashboard's Zod schemas treat absent and null differently."""
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    return obj


def response(status: int, body, headers: dict | None = None) -> dict:
    return _raw_response(status, _clean(body), headers)


# ----------------------------------------------------------------- auth
class Caller:
    def __init__(self, sub: str, groups: set[str]):
        self.sub = sub
        self.groups = groups

    @property
    def is_admin(self) -> bool:
        return "admin" in self.groups

    @property
    def is_analyst(self) -> bool:
        return self.is_admin or "analyst" in self.groups


def parse_groups(raw) -> set[str]:
    if raw is None:
        return set()
    if isinstance(raw, list):
        return {str(g) for g in raw}
    text = str(raw).strip().strip("[]")
    return {g for g in re.split(r"[\s,]+", text) if g}


def caller_from(event: dict) -> Caller:
    claims = (((event.get("requestContext") or {}).get("authorizer") or {}).get("jwt") or {}).get("claims") or {}
    return Caller(claims.get("sub", ""), parse_groups(claims.get("cognito:groups")))


def require(caller: Caller, admin: bool) -> None:
    if admin and not caller.is_admin:
        raise forbidden("this action requires the admin role")
    if not caller.is_analyst:
        raise forbidden("this action requires the analyst or admin role")


# ----------------------------------------------------------------- utilities
def _now() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _parse_time(value: str | None, field: str) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise invalid(f"{field} must be an ISO 8601 timestamp") from exc
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _qs(event: dict) -> dict:
    return event.get("queryStringParameters") or {}


def _path(event: dict, name: str) -> str:
    return (event.get("pathParameters") or {}).get(name, "")


def _enc_cursor(obj) -> str | None:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode() if obj else None


def _dec_cursor(value: str | None):
    if not value:
        return None
    try:
        return json.loads(base64.urlsafe_b64decode(value.encode()))
    except Exception as exc:
        raise invalid("cursor is invalid") from exc


def _all_apps() -> list[dict]:
    t = table("TABLE_APPS")
    items, kwargs = [], {}
    while True:
        page = t.scan(**kwargs)
        items.extend(from_ddb(page.get("Items", [])))
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _get_app_or_404(app_id: str) -> dict:
    app = apps_repo.get_app(app_id, cached=False)
    if not app:
        raise not_found(f"app {app_id} not found")
    return app


def _domains(raw) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(d, str) for d in raw):
        raise invalid("allowed_link_domains must be an array of strings")
    out = []
    for d in raw:
        d = d.strip().lower()
        if not DOMAIN_RE.match(d):
            raise invalid(f"allowed_link_domains contains an invalid domain: {d[:60]}")
        out.append(d)
    return sorted(set(out))


# ----------------------------------------------------------------- playground (BE-15)
def invoke_orchestrator(payload: dict) -> dict:
    resp = client("lambda").invoke(
        FunctionName=os.environ["ORCHESTRATOR_FUNCTION"],
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode(),
    )
    return json.loads(resp["Payload"].read())


def _rate_limit_playground(sub: str) -> None:
    now = int(time.time())
    minute = now // 60
    res = table("TABLE_STATS").update_item(
        Key={"pk": f"RATE#playground#{sub}", "sk": f"MIN#{minute}"},
        UpdateExpression="ADD n :one SET #ttl = :ttl",
        ExpressionAttributeNames={"#ttl": "ttl"},
        ExpressionAttributeValues={":one": 1, ":ttl": now + 180},
        ReturnValues="UPDATED_NEW",
    )
    if int(res["Attributes"]["n"]) > PLAYGROUND_PER_MINUTE:
        raise rate_limited(60 - now % 60)


def playground_scan(event, caller, rid):
    require(caller, admin=False)
    body = json_body(event, 64 * 1024)
    app_id = body.get("app_id")
    if not isinstance(app_id, str) or not app_id:
        raise invalid("app_id is required")
    judge = body.pop("judge_enabled", None)
    opts = body.get("options")
    if isinstance(opts, dict) and "judge_enabled" in opts:  # the dashboard sends it inside options
        judge = opts.pop("judge_enabled")
    if judge is not None and not isinstance(judge, bool):
        raise invalid("judge_enabled must be a boolean")
    _rate_limit_playground(caller.sub or "anonymous")
    return invoke_orchestrator(
        {"internal": "playground_scan", "app_id": app_id, "body": body, "judge_enabled": judge, "request_id": rid, "user_sub": caller.sub}
    )


# ----------------------------------------------------------------- verdicts
_SUMMARY_FIELDS = ("verdict_id", "app_id", "ts", "action", "would_action", "risk_score", "categories", "snippet", "degraded", "origin", "mode")


def _summary(item: dict) -> dict:
    out = {k: item.get(k) for k in _SUMMARY_FIELDS}
    out["created_at"] = item.get("ts")
    out["categories"] = sorted(item.get("categories") or [])
    out["latency_ms"] = (item.get("latency_ms") or {}).get("total")
    return out


def _query_app(app_id, *, actions, lo, hi, origins, min_risk, start_key, limit):
    t = table("TABLE_VERDICTS")
    if len(actions) == 1:
        kwargs = {"IndexName": "by-action", "KeyConditionExpression": Key("gsi_action_pk").eq(f"APP#{app_id}#ACT#{actions[0]}") & Key("sk").between(lo, hi)}
    else:
        kwargs = {"KeyConditionExpression": Key("pk").eq(f"APP#{app_id}") & Key("sk").between(lo, hi)}
    filt = Attr("origin").is_in(list(origins))
    if 1 < len(actions) < len(ACTIONS):
        filt = filt & Attr("action").is_in(list(actions))
    if min_risk is not None:
        filt = filt & Attr("risk_score").gte(to_ddb(min_risk))
    kwargs.update(FilterExpression=filt, ScanIndexForward=False, Limit=max(limit * 2, 25))
    items, exhausted = [], False
    for _ in range(5):
        if start_key:
            kwargs["ExclusiveStartKey"] = start_key
        page = t.query(**kwargs)
        items.extend(page.get("Items", []))
        start_key = page.get("LastEvaluatedKey")
        if not start_key:
            exhausted = True
            break
        if len(items) >= limit:
            break
    return items, exhausted


def list_verdicts(event, caller, rid):
    require(caller, admin=False)
    q = _qs(event)
    limit = min(int(q.get("limit", 50) or 50), MAX_PAGE)
    actions = [a for a in (q.get("action") or "").split(",") if a] or list(ACTIONS)
    if any(a not in ACTIONS for a in actions):
        raise invalid(f"action must be a comma-separated subset of {', '.join(ACTIONS)}")
    origins = [o for o in (q.get("origin") or "api,chat").split(",") if o]
    if any(o not in ORIGINS for o in origins):
        raise invalid(f"origin must be a comma-separated subset of {', '.join(ORIGINS)}")
    frm = _parse_time(q.get("from"), "from") or (_now() - timedelta(days=7))
    to = _parse_time(q.get("to"), "to") or (_now() + timedelta(minutes=1))
    lo, hi = f"TS#{_iso(frm)}", f"TS#{_iso(to)}~"
    min_risk = float(q["min_risk"]) if q.get("min_risk") else None
    app_ids = [q["app_id"]] if q.get("app_id") else [a["app_id"] for a in _all_apps()]
    cursor = _dec_cursor(q.get("cursor")) or {}

    fetched: dict[str, tuple[list, bool]] = {}
    for app_id in app_ids:
        pos = cursor.get(app_id)
        if pos == "__done__":
            continue
        fetched[app_id] = _query_app(app_id, actions=actions, lo=lo, hi=hi, origins=origins, min_risk=min_risk, start_key=pos, limit=limit)
    merged = sorted(((it, aid) for aid, (its, _) in fetched.items() for it in its), key=lambda t: t[0]["sk"], reverse=True)
    page = merged[:limit]
    key_attrs = ("pk", "sk", "gsi_action_pk") if len(actions) == 1 else ("pk", "sk")
    new_cursor = {aid: v for aid, v in cursor.items() if v == "__done__"}
    more = False
    for aid, (its, exhausted) in fetched.items():
        taken = [it for it, a in page if a == aid]
        if exhausted and len(taken) == len(its):
            new_cursor[aid] = "__done__"
            continue
        more = True
        new_cursor[aid] = {k: taken[-1][k] for k in key_attrs} if taken else cursor.get(aid)
    items = [_summary(from_ddb(it)) for it, _ in page]
    return response(200, {"items": items, "next_cursor": _enc_cursor(new_cursor) if more else None})


def get_verdict(event, caller, rid):
    require(caller, admin=False)
    vid = _path(event, "verdict_id")
    res = table("TABLE_VERDICTS").query(IndexName="by-id", KeyConditionExpression=Key("verdict_id").eq(vid), Limit=1)
    items = res.get("Items", [])
    if not items:
        raise not_found(f"verdict {vid} not found")
    item = from_ddb(items[0])
    for k in ("pk", "sk", "gsi_action_pk", "ttl"):
        item.pop(k, None)
    item["created_at"] = item.get("ts")
    item["categories"] = sorted(item.get("categories") or [])
    item["segments_summary"] = [_summary_layers(s) for s in item.get("segments_summary") or []]
    return response(200, item)


def _summary_layers(s: dict) -> dict:
    """Expose stored per-layer fields in the A.10 `layers` shape the dashboard renders."""
    def layer(d: dict | None) -> dict:
        d = dict(d or {})
        if d.get("skipped"):
            d["skipped_reason"] = d.pop("skipped")
        return d

    out = {k: v for k, v in s.items() if k not in ("heuristic", "classifier", "judge")}
    out["layers"] = {name: layer(s.get(name)) for name in ("heuristic", "classifier", "judge")}
    return out


# ----------------------------------------------------------------- stats
def get_stats(event, caller, rid):
    require(caller, admin=False)
    q = _qs(event)
    frm = _parse_time(q.get("from"), "from") or (_now() - timedelta(days=1))
    to = _parse_time(q.get("to"), "to") or _now()
    frm, to = frm.astimezone(UTC), to.astimezone(UTC)  # stats keys are UTC hours
    gran = q.get("granularity") or ("hour" if (to - frm) <= timedelta(days=2) else "day")
    if gran not in ("hour", "day"):
        raise invalid("granularity must be hour or day")
    origin = q.get("origin", "api")
    app_ids = [q["app_id"]] if q.get("app_id") else [a["app_id"] for a in _all_apps()]
    lo = f"DAY#{frm.strftime('%Y-%m-%d')}#HOUR#{frm.strftime('%H')}"
    hi = f"DAY#{to.strftime('%Y-%m-%d')}#HOUR#{to.strftime('%H')}"
    t = table("TABLE_STATS")
    buckets: dict[str, dict] = {}
    cats: dict[str, int] = {}
    for app_id in app_ids:
        pk = f"APP#{app_id}#PLAYGROUND" if origin == "playground" else f"APP#{app_id}"
        kwargs = {"KeyConditionExpression": Key("pk").eq(pk) & Key("sk").between(lo, hi)}
        while True:
            page = t.query(**kwargs)
            for raw in page.get("Items", []):
                it = from_ddb(raw)
                day, hour = it["sk"][4:14], it["sk"][-2:]
                label = f"{day}T{hour}:00:00Z" if gran == "hour" else f"{day}T00:00:00Z"
                b = buckets.setdefault(label, {c: 0 for c in COUNTERS} | {"hist": [0] * len(LAT_EDGES)})
                for c in COUNTERS:
                    b[c] += int(it.get(c, 0))
                for i in range(len(LAT_EDGES)):
                    b["hist"][i] += int(it.get(f"lat_b{i}", 0))
                for k, v in it.items():
                    if k.startswith("cat_"):
                        cats[k[4:]] = cats.get(k[4:], 0) + int(v)
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    series = []
    total_hist = [0] * len(LAT_EDGES)
    totals = {c: 0 for c in COUNTERS}
    for label in sorted(buckets):
        b = buckets[label]
        for c in COUNTERS:
            totals[c] += b[c]
        total_hist = [x + y for x, y in zip(total_hist, b["hist"])]
        series.append(_bucket_view(label, b, b["hist"]))
    n = totals["total"]

    def rate(c):
        return round(totals[c] / n, 4) if n else 0.0

    kpis = {
        "total": n,
        "block_rate": rate("block"),
        "flag_rate": rate("flag"),
        "judge_escalation_rate": rate("judged"),
        "degraded_rate": rate("degraded"),
        "p95_ms": percentile(total_hist, 0.95),
        "p50_ms": percentile(total_hist, 0.5),
    }
    top = sorted(({"category": k, "count": v} for k, v in cats.items()), key=lambda x: -x["count"])[:10]
    totals_view = _bucket_view(None, totals, total_hist)
    totals_view.pop("ts", None)
    return response(
        200,
        {"granularity": gran, "from": _iso(frm), "to": _iso(to), "buckets": series, "totals": totals_view, "categories": top, "kpis": kpis},
    )


def _bucket_view(label: str | None, counts: dict, hist: list[int]) -> dict:
    """Dashboard shape: `judge_calls` counts requests escalated to the judge (FE-10 escalation rate);
    `judge_invocations` is the raw number of judge calls."""
    return {
        "ts": label,
        **{c: counts[c] for c in ("total", "allow", "flag", "sanitize", "block", "degraded")},
        "judge_calls": counts["judged"],
        "judge_invocations": counts["judge_calls"],
        "p50_ms": percentile(hist, 0.5),
        "p95_ms": percentile(hist, 0.95),
    }


# ----------------------------------------------------------------- apps
def list_apps(event, caller, rid):
    require(caller, admin=False)
    apps = sorted((apps_repo.public_view(a) for a in _all_apps()), key=lambda a: a["app_id"])
    return response(200, {"apps": apps})


def create_app(event, caller, rid):
    require(caller, admin=True)
    body = json_body(event, 64 * 1024)
    app_id = body.get("app_id")
    if not isinstance(app_id, str) or not APP_ID_RE.match(app_id):
        raise invalid("app_id must be 3-40 characters of a-z, 0-9 or -")
    name = body.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
        raise invalid("name must be 1-100 characters")
    chat_model = body.get("chat_model_id")
    if chat_model is not None and (not isinstance(chat_model, str) or len(chat_model) > 200):
        raise invalid("chat_model_id must be a string")
    try:
        policy = validate_policy(body.get("policy") or {})
    except PolicyError as exc:
        raise invalid(str(exc)) from exc
    key = new_api_key()
    now = _iso(_now())
    item = {
        "app_id": app_id,
        "name": name.strip(),
        "key_hash": key_hash(key),
        "key_prefix": key_prefix(key),
        "policy": policy,
        "policy_version": 1,
        "allowed_link_domains": set(_domains(body.get("allowed_link_domains"))),
        "chat_model_id": chat_model,
        "status": "active",
        "created_at": now,
        "updated_at": now,
        "updated_by": caller.sub,
    }
    try:
        table("TABLE_APPS").put_item(Item=to_ddb(item), ConditionExpression="attribute_not_exists(app_id)")
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise conflict(f"app {app_id} already exists") from exc
        raise
    log("app created", request_id=rid, app_id=app_id, user_sub=caller.sub)
    item["allowed_link_domains"] = sorted(item["allowed_link_domains"])
    return response(201, {"app": apps_repo.public_view(item), "api_key": key})


def update_app(event, caller, rid):
    require(caller, admin=True)
    app_id = _path(event, "app_id")
    _get_app_or_404(app_id)
    body = json_body(event, 16 * 1024)
    sets, removes, values, names = ["updated_at = :u", "updated_by = :by"], [], {":u": _iso(_now()), ":by": caller.sub}, {}
    if "status" in body:
        if body["status"] not in ("active", "disabled"):
            raise invalid("status must be active or disabled")
        sets.append("#st = :st")
        names["#st"] = "status"
        values[":st"] = body["status"]
    if "name" in body:
        if not isinstance(body["name"], str) or not 1 <= len(body["name"].strip()) <= 100:
            raise invalid("name must be 1-100 characters")
        sets.append("#nm = :nm")
        names["#nm"] = "name"
        values[":nm"] = body["name"].strip()
    if "allowed_link_domains" in body:
        doms = _domains(body["allowed_link_domains"])
        if doms:
            sets.append("allowed_link_domains = :d")
            values[":d"] = set(doms)
        else:
            removes.append("allowed_link_domains")
    if "chat_model_id" in body:
        if body["chat_model_id"]:
            sets.append("chat_model_id = :m")
            values[":m"] = str(body["chat_model_id"])[:200]
        else:
            removes.append("chat_model_id")
    expr = "SET " + ", ".join(sets) + (" REMOVE " + ", ".join(removes) if removes else "")
    kwargs = {"Key": {"app_id": app_id}, "UpdateExpression": expr, "ExpressionAttributeValues": values, "ReturnValues": "ALL_NEW"}
    if names:
        kwargs["ExpressionAttributeNames"] = names
    res = table("TABLE_APPS").update_item(**kwargs)
    apps_repo.clear_cache()
    return response(200, {"app": apps_repo.public_view(from_ddb(res["Attributes"]))})


def rotate_key(event, caller, rid):
    require(caller, admin=True)
    app_id = _path(event, "app_id")
    app = _get_app_or_404(app_id)
    key = new_api_key()
    expires = _iso(_now() + timedelta(hours=KEY_GRACE_HOURS))
    table("TABLE_APPS").update_item(
        Key={"app_id": app_id},
        UpdateExpression="SET key_hash = :k, key_prefix = :p, prev_key_hash = :old, prev_key_expires_at = :exp, updated_at = :u, updated_by = :by",
        ExpressionAttributeValues={
            ":k": key_hash(key),
            ":p": key_prefix(key),
            ":old": app["key_hash"],
            ":exp": expires,
            ":u": _iso(_now()),
            ":by": caller.sub,
        },
    )
    log("key rotated", request_id=rid, app_id=app_id, user_sub=caller.sub)
    return response(200, {"app_id": app_id, "api_key": key, "key_prefix": key_prefix(key), "prev_key_expires_at": expires, "grace_hours": KEY_GRACE_HOURS})


def get_policy(event, caller, rid):
    require(caller, admin=False)
    app = _get_app_or_404(_path(event, "app_id"))
    return response(200, {"app_id": app["app_id"], "policy": validate_policy(app.get("policy") or {}), "policy_version": app.get("policy_version", 0),
                          "allowed_link_domains": sorted(app.get("allowed_link_domains") or []), "updated_at": app.get("updated_at"), "updated_by": app.get("updated_by")})


def put_policy(event, caller, rid):
    require(caller, admin=True)
    app_id = _path(event, "app_id")
    _get_app_or_404(app_id)
    body = json_body(event, 64 * 1024)
    version = body.get("policy_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise invalid("policy_version is required and must be an integer")
    try:
        policy = validate_policy(body.get("policy") or {})
    except PolicyError as exc:
        raise invalid(str(exc)) from exc
    expr = "SET policy = :p, policy_version = :new, updated_at = :u, updated_by = :by"
    values = {":p": policy, ":new": version + 1, ":old": version, ":u": _iso(_now()), ":by": caller.sub}
    if "allowed_link_domains" in body:  # the policy editor saves link domains with the policy
        doms = _domains(body["allowed_link_domains"])
        if doms:
            expr += ", allowed_link_domains = :d"
            values[":d"] = set(doms)
        else:
            expr += " REMOVE allowed_link_domains"
    try:
        res = table("TABLE_APPS").update_item(
            Key={"app_id": app_id},
            UpdateExpression=expr,
            ConditionExpression="policy_version = :old",
            ExpressionAttributeValues=to_ddb(values),
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise conflict("policy_version is stale; this policy was changed by someone else") from exc
        raise
    apps_repo.clear_cache()
    item = from_ddb(res["Attributes"])
    log("policy updated", request_id=rid, app_id=app_id, user_sub=caller.sub)
    return response(200, {"app_id": app_id, "policy": item["policy"], "policy_version": item["policy_version"], "allowed_link_domains": sorted(item.get("allowed_link_domains") or [])})


# ----------------------------------------------------------------- datasets and eval runs
def _bucket() -> str:
    return os.environ["EVAL_BUCKET"]


def list_datasets(event, caller, rid):
    require(caller, admin=False)
    s3 = client("s3")
    res = s3.list_objects_v2(Bucket=_bucket(), Prefix="datasets/", Delimiter="/")
    items = []
    for cp in res.get("CommonPrefixes", []):
        version = cp["Prefix"].split("/")[1]
        try:
            manifest = json.loads(s3.get_object(Bucket=_bucket(), Key=f"datasets/{version}/manifest.json")["Body"].read())
        except Exception:
            manifest = {}
        items.append({"dataset_version": version, "item_count": manifest.get("item_count"), "created_at": manifest.get("created_at"),
                      "groups": manifest.get("groups"), "sources": manifest.get("sources", [])})
    return response(200, {"datasets": sorted(items, key=lambda d: d["dataset_version"])})


def create_eval_run(event, caller, rid):
    require(caller, admin=True)
    body = json_body(event, 16 * 1024)
    dataset = body.get("dataset_version")
    configs = body.get("configs")
    sweep = body.get("thresholds_sweep", True)
    if not isinstance(dataset, str) or not re.match(r"^[A-Za-z0-9._-]{1,40}$", dataset):
        raise invalid("dataset_version is required")
    if not isinstance(configs, list) or not configs or any(c not in EVAL_CONFIGS for c in configs):
        raise invalid(f"configs must be a non-empty subset of {', '.join(EVAL_CONFIGS)}")
    if not isinstance(sweep, bool):
        raise invalid("thresholds_sweep must be a boolean")
    try:
        client("s3").head_object(Bucket=_bucket(), Key=f"datasets/{dataset}/items.jsonl")
    except ClientError as exc:
        raise not_found(f"dataset {dataset} not found") from exc
    run_id = ulid()
    item = {"run_id": run_id, "status": "queued", "dataset_version": dataset, "configs": list(dict.fromkeys(configs)),
            "thresholds_sweep": sweep, "s3_prefix": f"runs/{run_id}/", "created_by": caller.sub, "created_at": _iso(_now())}
    t = table("TABLE_EVAL_RUNS")
    t.put_item(Item=item)
    try:
        client("stepfunctions").start_execution(
            stateMachineArn=os.environ["EVAL_STATE_MACHINE_ARN"], name=run_id,
            input=json.dumps({"run_id": run_id, "dataset_version": dataset, "configs": item["configs"], "thresholds_sweep": sweep}),
        )
    except Exception as exc:
        t.update_item(Key={"run_id": run_id}, UpdateExpression="SET #s = :f, #e = :e",
                      ExpressionAttributeNames={"#s": "status", "#e": "error"}, ExpressionAttributeValues={":f": "failed", ":e": "could not start"})
        raise ApiError(500, "INTERNAL", "could not start the evaluation run") from exc
    return response(201, item)


def list_eval_runs(event, caller, rid):
    require(caller, admin=False)
    t = table("TABLE_EVAL_RUNS")
    items, kwargs = [], {}
    while True:
        page = t.scan(**kwargs)
        items.extend(from_ddb(page.get("Items", [])))
        if "LastEvaluatedKey" not in page:
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    items.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return response(200, {"runs": [_run_view(r) for r in items[:200]]})


def get_eval_run(event, caller, rid):
    require(caller, admin=False)
    run_id = _path(event, "run_id")
    item = table("TABLE_EVAL_RUNS").get_item(Key={"run_id": run_id}).get("Item")
    if not item:
        raise not_found(f"run {run_id} not found")
    item = from_ddb(item)
    if item.get("status") == "succeeded":
        s3 = client("s3")
        prefix = item["s3_prefix"]

        def url(key):
            return s3.generate_presigned_url("get_object", Params={"Bucket": _bucket(), "Key": key}, ExpiresIn=900)

        item["results_url"] = url(f"{prefix}results.json")
        item["predictions_urls"] = {c: url(f"{prefix}predictions/{c}.jsonl") for c in item.get("configs", [])}
        try:
            results = json.loads(s3.get_object(Bucket=_bucket(), Key=f"{prefix}results.json")["Body"].read())
        except Exception:
            results = None
        if results:
            configs = results.get("configs") or {}
            item["metrics"] = {c: _metrics_view(m) for c, m in configs.items()}
            item["sweep"] = {c: m["sweep"] for c, m in configs.items() if m.get("sweep")}
            item["misclassified"] = [
                {**m, "config": c, "kind": "fn" if m.get("kind") == "false_negative" else "fp"}
                for c, ms in (results.get("misclassified") or {}).items()
                for m in ms
            ]
    item["default_threshold"] = 0.5  # positive = FLAG or worse, i.e. risk >= default flag threshold
    return response(200, _run_view(item))


def _metrics_view(m: dict) -> dict:
    """Dashboard metric shape: flat per-category recall and `cost_per_1k`."""
    out = {k: v for k, v in m.items() if k not in ("sweep", "block_only")}
    out["cost_per_1k"] = m.get("cost_per_1k_usd")
    out["per_category_recall"] = {
        cat: (v.get("recall") if isinstance(v, dict) else v) for cat, v in (m.get("per_category_recall") or {}).items()
    }
    return out


def _run_view(run: dict) -> dict:
    run = dict(run)
    run["metrics"] = {c: (m if "cost_per_1k" in m else _metrics_view(m)) for c, m in (run.get("metrics") or {}).items()}
    return run


# ----------------------------------------------------------------- router
ROUTES = {
    "POST /v1/admin/playground/scan": playground_scan,
    "GET /v1/admin/verdicts": list_verdicts,
    "GET /v1/admin/verdicts/{verdict_id}": get_verdict,
    "GET /v1/admin/stats": get_stats,
    "GET /v1/admin/apps": list_apps,
    "POST /v1/admin/apps": create_app,
    "PATCH /v1/admin/apps/{app_id}": update_app,
    "POST /v1/admin/apps/{app_id}/rotate-key": rotate_key,
    "GET /v1/admin/apps/{app_id}/policy": get_policy,
    "PUT /v1/admin/apps/{app_id}/policy": put_policy,
    "GET /v1/admin/datasets": list_datasets,
    "POST /v1/admin/eval-runs": create_eval_run,
    "GET /v1/admin/eval-runs": list_eval_runs,
    "GET /v1/admin/eval-runs/{run_id}": get_eval_run,
}


def handler(event, _context):
    rid = request_id(event)
    route = event.get("routeKey", "")
    try:
        fn = ROUTES.get(route)
        if fn is None:
            raise not_found("unknown route")
        return fn(event, caller_from(event), rid)
    except ApiError as err:
        log("admin request rejected", level="warn", request_id=rid, route=route, status=err.status, error_code=err.code)
        return error_response(err, rid)
    except Exception as exc:
        log("admin unhandled error", level="error", request_id=rid, route=route, error_type=type(exc).__name__)
        return internal_error(rid)
