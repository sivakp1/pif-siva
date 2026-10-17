"""L2 classifier Lambda (container image): ONNX inference on CPU (CORE-14/15).

Event:    {"chunks": ["text", ...]}            -> {"scores": [p_injection, ...], "version": "..."}
Event:    {"warmup": true}                     -> loads the model, returns {"warm": true}

The ~740 MB model is loaded lazily on the first invocation rather than at import:
Lambda caps container init at 10 s, and a model load that overruns it is retried on
every call, so the container would never become warm.
"""

from __future__ import annotations

import json
import os
import sys
import time

import numpy as np

MODEL_DIR = os.environ.get("MODEL_DIR", "/opt/model")
MAX_TOKENS = 512
BATCH = 8
VERSION = os.environ.get("CLASSIFIER_VERSION", "protectai-deberta-v3-base-pi-v2-onnx-1")

_state: dict = {}


def _load() -> dict:
    if _state:
        return _state
    import onnxruntime as ort
    from tokenizers import Tokenizer

    t0 = time.perf_counter()
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = int(os.environ.get("ORT_THREADS", "2"))
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    session = ort.InferenceSession(os.path.join(MODEL_DIR, "model.onnx"), opts, providers=["CPUExecutionProvider"])
    tok = Tokenizer.from_file(os.path.join(MODEL_DIR, "tokenizer.json"))
    tok.enable_truncation(max_length=MAX_TOKENS)
    tok.enable_padding(pad_id=tok.token_to_id("[PAD]") or 0, pad_token="[PAD]")
    with open(os.path.join(MODEL_DIR, "config.json"), encoding="utf-8") as fh:
        labels = {int(k): v.upper() for k, v in json.load(fh).get("id2label", {}).items()}
    _state.update(
        session=session,
        inputs={i.name for i in session.get_inputs()},
        tok=tok,
        # ProtectAI v2: {0: SAFE, 1: INJECTION}
        idx=next((i for i, name in labels.items() if "INJECTION" in name or "JAILBREAK" in name), 1),
    )
    print(json.dumps({"level": "info", "msg": "classifier model loaded", "latency_ms": int((time.perf_counter() - t0) * 1000)}), file=sys.stdout, flush=True)
    return _state


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


def _score_batch(st: dict, texts: list[str]) -> list[float]:
    enc = st["tok"].encode_batch(texts)
    feeds = {
        "input_ids": np.array([e.ids for e in enc], dtype=np.int64),
        "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64),
        "token_type_ids": np.array([e.type_ids for e in enc], dtype=np.int64),
    }
    logits = st["session"].run(None, {k: v for k, v in feeds.items() if k in st["inputs"]})[0]
    return _softmax(logits)[:, st["idx"]].astype(float).tolist()


def handler(event, _context):
    st = _load()
    if event.get("warmup"):
        return {"warm": True, "version": VERSION}
    chunks = event.get("chunks") or []
    if not isinstance(chunks, list) or not all(isinstance(c, str) for c in chunks):
        return {"error": "chunks must be a list of strings", "scores": None, "version": VERSION}
    scores: list[float] = []
    for i in range(0, len(chunks), BATCH):
        scores.extend(_score_batch(st, chunks[i : i + BATCH]))
    return {"scores": [round(s, 6) for s in scores], "version": VERSION}
