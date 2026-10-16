"""Build dataset v1 (EVAL-01 / EVAL-02) from public sources plus synthetic generators.

Sources are fetched through the Hugging Face datasets-server REST API (no
`datasets` dependency). The manifest records source, licence, revision and the
SHA-256 of each fetched source file.
"""

from __future__ import annotations

import hashlib
import json
import random
import time
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from . import synth

ROWS_API = "https://datasets-server.huggingface.co/rows"
INFO_API = "https://huggingface.co/api/datasets/{}"

SOURCES = {
    "deepset/prompt-injections": {"licence": "Apache-2.0", "splits": ["train", "test"]},
    "jackhhao/jailbreak-classification": {"licence": "Apache-2.0", "splits": ["train", "test"]},
    "tatsu-lab/alpaca": {"licence": "CC-BY-NC-4.0", "splits": ["train"], "max_rows": 3000},
}


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "pif-eval/1.0"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def fetch_rows(dataset: str, split: str, max_rows: int | None = None) -> tuple[list[dict], str]:
    rows, offset, raw_all = [], 0, hashlib.sha256()
    while True:
        q = urllib.parse.urlencode({"dataset": dataset, "config": "default", "split": split, "offset": offset, "length": 100})
        raw = _get(f"{ROWS_API}?{q}")
        raw_all.update(raw)
        data = json.loads(raw)
        batch = [r["row"] for r in data.get("rows", [])]
        rows.extend(batch)
        offset += len(batch)
        if not batch or offset >= data.get("num_rows_total", 0) or (max_rows and offset >= max_rows):
            return rows[: max_rows or None], raw_all.hexdigest()


def revision(dataset: str) -> str:
    try:
        return json.loads(_get(INFO_API.format(dataset))).get("sha", "unknown")
    except Exception:
        return "unknown"


def _item(id_, text, label, category, source, split, docs=None):
    return {"id": id_, "input": text, "context_docs": docs or [], "label": label, "category": category, "source": source, "split": split}


def build(out_dir: Path, version: str = "v1", seed: int = 42) -> dict:
    rng = random.Random(seed)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_sources, items = [], []

    def record(name, split, sha, n):
        manifest_sources.append({"source": name, "split": split, "licence": SOURCES[name]["licence"], "revision": revision(name), "sha256": sha, "rows": n})

    # Direct attacks + some benign: deepset/prompt-injections
    deepset = []
    for split in SOURCES["deepset/prompt-injections"]["splits"]:
        rows, sha = fetch_rows("deepset/prompt-injections", split)
        record("deepset/prompt-injections", split, sha, len(rows))
        deepset += [(r, split) for r in rows]
    for i, (r, split) in enumerate(deepset):
        label = "attack" if int(r["label"]) == 1 else "benign"
        items.append(_item(f"deepset-{i:04d}", r["text"], label, "direct" if label == "attack" else "benign_plain", "deepset/prompt-injections", split))

    # Jailbreak / role-play
    jb = []
    for split in SOURCES["jackhhao/jailbreak-classification"]["splits"]:
        rows, sha = fetch_rows("jackhhao/jailbreak-classification", split)
        record("jackhhao/jailbreak-classification", split, sha, len(rows))
        jb += [(r, split) for r in rows if r.get("type") == "jailbreak"]
    rng.shuffle(jb)
    for i, (r, split) in enumerate(jb[:200]):
        items.append(_item(f"jailbreak-{i:04d}", r["prompt"], "attack", "roleplay", "jackhhao/jailbreak-classification", split))

    # Benign plain: Alpaca
    rows, sha = fetch_rows("tatsu-lab/alpaca", "train", SOURCES["tatsu-lab/alpaca"]["max_rows"])
    record("tatsu-lab/alpaca", "train", sha, len(rows))
    rng.shuffle(rows)
    need = 600 - sum(1 for i in items if i["category"] == "benign_plain")
    for i, r in enumerate(rows[: max(need, 0)]):
        text = r["instruction"] + (("\n\n" + r["input"]) if r.get("input") else "")
        items.append(_item(f"alpaca-{i:04d}", text, "benign", "benign_plain", "tatsu-lab/alpaca", "test"))

    # Synthetic groups
    direct_texts = [i["input"] for i in items if i["category"] == "direct"][:200] + synth.DIRECT_ATTACKS
    items += synth.indirect_items(300, seed=seed)
    items += synth.encoded_items(direct_texts, 94, seed=seed)
    items += synth.multilingual_items()
    items += synth.hard_negative_items(200, seed=seed)
    items += synth.benign_context_items(100, seed=seed)

    # Splits: 30% dev / 70% test for public data; holdout kept separate
    for it in items:
        if it["split"] != "test" or it["source"].startswith("synthetic"):
            it["split"] = "dev" if rng.random() < 0.3 else "test"
    holdout_path = Path(__file__).resolve().parents[1] / "data" / "holdout.jsonl"
    if holdout_path.exists():
        for line in holdout_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                h = json.loads(line)
                h["split"] = "holdout"
                items.append(h)

    lines = "\n".join(json.dumps(i, ensure_ascii=False) for i in items) + "\n"
    (out_dir / "items.jsonl").write_text(lines, encoding="utf-8")
    groups: dict[str, int] = {}
    for i in items:
        groups[i["category"]] = groups.get(i["category"], 0) + 1
    manifest = {
        "dataset_version": version,
        "created_at": datetime.now(UTC).isoformat(),
        "item_count": len(items),
        "items_sha256": hashlib.sha256(lines.encode()).hexdigest(),
        "groups": groups,
        "splits": {s: sum(1 for i in items if i["split"] == s) for s in ("dev", "test", "holdout")},
        "sources": manifest_sources
        + [{"source": "synthetic (pif_eval.synth)", "licence": "project", "revision": f"seed={seed}", "sha256": None}],
        "notes": "Indirect attacks are synthetic BIPIA-style items; jailbreaks come from jackhhao/jailbreak-classification as a JailbreakBench substitute.",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest
