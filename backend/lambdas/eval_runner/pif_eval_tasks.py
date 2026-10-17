"""eval-runner task Lambdas used by the Step Functions state machine (EVAL-03 … EVAL-06).

Scans go through the orchestrator's internal `eval_scan` handler and results go
only to S3 — never to pif-verdicts or pif-stats (EVAL-06).
"""

from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

from pif_common.aws import client, table, to_ddb
from pif_common.obs import log
from pif_eval.metrics import config_metrics, misclassified

BATCH_SIZE = int(os.environ.get("EVAL_BATCH_SIZE", "50"))
SCAN_WORKERS = int(os.environ.get("EVAL_SCAN_WORKERS", "4"))
DEGRADED_RETRIES = int(os.environ.get("EVAL_DEGRADED_RETRIES", "3"))
RETRY_PAUSE_S = float(os.environ.get("EVAL_RETRY_PAUSE_S", "5"))
L2_CONFIGS = {"L1+L2", "L1+L2+L3"}
_items_cache: dict[str, list[dict]] = {}


def _bucket() -> str:
    return os.environ["EVAL_BUCKET"]


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _items(dataset: str) -> list[dict]:
    if dataset not in _items_cache:
        body = client("s3").get_object(Bucket=_bucket(), Key=f"datasets/{dataset}/items.jsonl")["Body"].read().decode()
        _items_cache[dataset] = [json.loads(line) for line in body.splitlines() if line.strip()]
    return _items_cache[dataset]


def _set_status(run_id: str, status: str, **extra) -> None:
    names = {"#s": "status"}
    values = {":s": status}
    sets = ["#s = :s"]
    for i, (k, v) in enumerate(extra.items()):
        names[f"#k{i}"] = k
        values[f":v{i}"] = v
        sets.append(f"#k{i} = :v{i}")
    table("TABLE_EVAL_RUNS").update_item(
        Key={"run_id": run_id}, UpdateExpression="SET " + ", ".join(sets),
        ExpressionAttributeNames=names, ExpressionAttributeValues=to_ddb(values),
    )


# ----------------------------------------------------------------- prepare
def prepare(event, _context):
    run_id, dataset = event["run_id"], event["dataset_version"]
    items = _items(dataset)
    split = event.get("split")
    if split:
        items = [i for i in items if i.get("split") == split]
    client("s3").put_object(Bucket=_bucket(), Key=f"runs/{run_id}/config.json", Body=json.dumps(event).encode(), ContentType="application/json")
    _set_status(run_id, "running", started_at=_now(), item_count=len(items))
    tasks = [
        {"run_id": run_id, "dataset_version": dataset, "config": cfg, "offset": off, "count": min(BATCH_SIZE, len(items) - off), "split": split}
        for cfg in event["configs"]
        for off in range(0, len(items), BATCH_SIZE)
    ]
    return {**event, "tasks": tasks}


# ----------------------------------------------------------------- scan batch
def _orchestrator_scan(item: dict, config: str) -> dict:
    resp = client("lambda").invoke(
        FunctionName=os.environ["ORCHESTRATOR_FUNCTION"],
        InvocationType="RequestResponse",
        Payload=json.dumps({"internal": "eval_scan", "item": item, "config": config}).encode(),
    )
    out = json.loads(resp["Payload"].read())
    if resp.get("FunctionError"):
        return {"id": item.get("id"), "label": item.get("label"), "category": item.get("category"), "action": "allow", "risk": 0.0, "error": "scan_failed"}
    return out


def _guardrail_scan(item: dict) -> dict:
    text = "\n\n".join([item.get("input") or ""] + [d["content"] if isinstance(d, dict) else d for d in item.get("context_docs", [])]).strip()
    t0 = time.perf_counter()
    try:
        res = client("bedrock-runtime").apply_guardrail(
            guardrailIdentifier=os.environ["GUARDRAIL_ID"],
            guardrailVersion=os.environ.get("GUARDRAIL_VERSION", "DRAFT"),
            source="INPUT",
            content=[{"text": {"text": text[:25000]}}],
        )
        action = "block" if res.get("action") == "GUARDRAIL_INTERVENED" else "allow"
        err = None
    except Exception as exc:
        action, err = "allow", type(exc).__name__
    latency = int((time.perf_counter() - t0) * 1000)
    out = {"id": item.get("id"), "label": item.get("label"), "category": item.get("category"), "action": action,
           "risk": 1.0 if action == "block" else 0.0, "latency_ms": latency, "judge_calls": 0, "chars": len(text)}
    if err:
        out["error"] = err
    return out


def warm_classifier(containers: int) -> int:
    """EVAL-08: load the model in `containers` classifier containers before scanning.

    A cold container needs longer than CLASSIFIER_TIMEOUT_MS to load the model, so without
    this the first scans of each batch fall back to rules only. Returns how many warmups succeeded.
    """
    fn = os.environ.get("CLASSIFIER_FUNCTION")
    if not fn:
        return 0
    lam = client("lambda", read_timeout=90, retries=0)

    def warm(_):
        try:
            resp = lam.invoke(FunctionName=fn, InvocationType="RequestResponse", Payload=b'{"warmup": true}')
            return not resp.get("FunctionError")
        except Exception as exc:  # throttling etc.: the degraded-scan retries still cover it
            log("classifier warmup failed", level="warning", error_type=type(exc).__name__)
            return False

    with ThreadPoolExecutor(max_workers=containers) as pool:
        return sum(pool.map(warm, range(containers)))


def _scan_with_retries(batch: list[dict], config: str) -> list[dict]:
    with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        preds = list(pool.map(lambda it: _orchestrator_scan(it, config), batch))
        if config not in L2_CONFIGS:
            return preds
        # EVAL-08: a degraded L2 scan is a classifier timeout, not a property of the item; rescan it.
        for _ in range(DEGRADED_RETRIES):
            retry = [i for i, p in enumerate(preds) if p.get("degraded")]
            if not retry:
                break
            time.sleep(RETRY_PAUSE_S)
            for i, p in zip(retry, pool.map(lambda i: _orchestrator_scan(batch[i], config), retry)):
                preds[i] = p
    return preds


def scan_batch(event, _context):
    items = _items(event["dataset_version"])
    if event.get("split"):
        items = [i for i in items if i.get("split") == event["split"]]
    batch = items[event["offset"] : event["offset"] + event["count"]]
    config = event["config"]
    if config == "bedrock_guardrails":
        preds = [_guardrail_scan(it) for it in batch]
    else:
        if config in L2_CONFIGS:
            warm_classifier(SCAN_WORKERS)
        preds = _scan_with_retries(batch, config)
        degraded = sum(1 for p in preds if p.get("degraded"))
        if degraded:
            log("degraded scans remain after retries", level="warning", run_id=event["run_id"], count=degraded)
    for p, it in zip(preds, batch):
        p.setdefault("label", it.get("label"))
        p.setdefault("category", it.get("category"))
    key = f"runs/{event['run_id']}/parts/{config}/{event['offset']:06d}.jsonl"
    client("s3").put_object(Bucket=_bucket(), Key=key, Body="\n".join(json.dumps(p) for p in preds).encode())
    return {"config": config, "key": key, "count": len(preds)}


# ----------------------------------------------------------------- aggregate
def aggregate(event, _context):
    run_id = event["run_id"]
    s3 = client("s3")
    items_by_id = {i.get("id"): i for i in _items(event["dataset_version"])}
    results = {"run_id": run_id, "dataset_version": event["dataset_version"], "generated_at": _now(), "configs": {}, "misclassified": {}}
    summary = {}
    for cfg in event["configs"]:
        prefix = f"runs/{run_id}/parts/{cfg}/"
        keys = []
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=_bucket(), Prefix=prefix):
            keys.extend(o["Key"] for o in page.get("Contents", []))
        preds = []
        for key in sorted(keys):
            body = s3.get_object(Bucket=_bucket(), Key=key)["Body"].read().decode()
            preds.extend(json.loads(line) for line in body.splitlines() if line.strip())
        s3.put_object(Bucket=_bucket(), Key=f"runs/{run_id}/predictions/{cfg}.jsonl", Body="\n".join(json.dumps(p) for p in preds).encode())
        m = config_metrics(preds, cfg, with_sweep=event.get("thresholds_sweep", True))
        results["configs"][cfg] = m
        results["misclassified"][cfg] = misclassified(preds, items_by_id)
        summary[cfg] = {k: m[k] for k in ("n", "tp", "fp", "tn", "fn", "precision", "recall", "f1", "fpr", "fpr_hard",
                                          "p50_ms", "p95_ms", "judge_escalation_rate", "cost_per_1k_usd", "degraded")}
    s3.put_object(Bucket=_bucket(), Key=f"runs/{run_id}/results.json", Body=json.dumps(results).encode(), ContentType="application/json")
    _set_status(run_id, "succeeded", metrics=summary, finished_at=_now())
    log("eval run succeeded", run_id=run_id)
    return {"run_id": run_id, "status": "succeeded"}


def mark_failed(event, _context):
    run_id = event["run_id"]
    err = event.get("error") or {}
    message = (err.get("Error") or "error") if isinstance(err, dict) else str(err)
    _set_status(run_id, "failed", error=str(message)[:500], finished_at=_now())
    log("eval run failed", level="error", run_id=run_id)
    return {"run_id": run_id, "status": "failed"}
