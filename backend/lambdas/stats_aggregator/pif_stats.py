"""stats-aggregator: DynamoDB Streams (NEW_IMAGE) on pif-verdicts -> pif-stats hourly counters (BE-09)."""

from __future__ import annotations

import re

from boto3.dynamodb.types import TypeDeserializer

from pif_common.aws import table
from pif_common.obs import log
from pif_common.stats import bucket_index, stats_pk, stats_sk

_deser = TypeDeserializer()
_SAFE_CAT = re.compile(r"[^a-z0-9_]")


def _image(record: dict) -> dict:
    img = record.get("dynamodb", {}).get("NewImage") or {}
    return {k: _deser.deserialize(v) for k, v in img.items()}


def updates_for(item: dict) -> tuple[dict, dict]:
    """Returns (key, counters) for one verdict."""
    origin = item.get("origin", "api")
    key = {"pk": stats_pk(item["app_id"], origin), "sk": stats_sk(item["ts"])}
    action = item.get("action", "allow")
    judge_calls = int(item.get("judge_calls", 0))
    counters = {
        "total": 1,
        action: 1,
        "degraded": 1 if item.get("degraded") else 0,
        "judge_calls": judge_calls,
        "judged": 1 if judge_calls else 0,
        f"lat_b{bucket_index(float((item.get('latency_ms') or {}).get('total', 0)))}": 1,
    }
    if item.get("would_action") and item["would_action"] != action:
        counters[f"would_{item['would_action']}"] = 1
    for cat in item.get("categories") or []:
        counters[f"cat_{_SAFE_CAT.sub('_', str(cat).lower())}"] = 1
    return key, {k: v for k, v in counters.items() if v}


def handler(event, _context):
    t = table("TABLE_STATS")
    failures = []
    for record in event.get("Records", []):
        if record.get("eventName") != "INSERT":
            continue
        try:
            item = _image(record)
            if item.get("origin") == "eval":  # EVAL-06 guard
                continue
            key, counters = updates_for(item)
            names = {f"#c{i}": k for i, k in enumerate(counters)}
            values = {f":v{i}": v for i, v in enumerate(counters.values())}
            expr = "ADD " + ", ".join(f"#c{i} :v{i}" for i in range(len(counters)))
            t.update_item(Key=key, UpdateExpression=expr, ExpressionAttributeNames=names, ExpressionAttributeValues=values)
        except Exception as exc:
            log("stats update failed", level="error", error_type=type(exc).__name__)
            failures.append({"itemIdentifier": record.get("dynamodb", {}).get("SequenceNumber")})
    return {"batchItemFailures": failures}
