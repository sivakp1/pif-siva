"""L2 classifier Lambda (container image): ONNX inference on CPU (CORE-14/15).

Event:    {"chunks": ["text", ...]}
Response: {"scores": [p_injection, ...], "version": "..."}
"""

from __future__ import annotations

import json
import os

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIR = os.environ.get("MODEL_DIR", "/opt/model")
MAX_TOKENS = 512
BATCH = 8
VERSION = os.environ.get("CLASSIFIER_VERSION", "protectai-deberta-v3-base-pi-v2-onnx-1")

_opts = ort.SessionOptions()
_opts.intra_op_num_threads = int(os.environ.get("ORT_THREADS", "2"))
_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
_session = ort.InferenceSession(os.path.join(MODEL_DIR, "model.onnx"), _opts, providers=["CPUExecutionProvider"])
_input_names = {i.name for i in _session.get_inputs()}

_tok = Tokenizer.from_file(os.path.join(MODEL_DIR, "tokenizer.json"))
_tok.enable_truncation(max_length=MAX_TOKENS)

with open(os.path.join(MODEL_DIR, "config.json"), encoding="utf-8") as fh:
    _labels = {int(k): v.upper() for k, v in json.load(fh).get("id2label", {}).items()}
# ProtectAI v2: {0: SAFE, 1: INJECTION}
INJECTION_IDX = next((i for i, name in _labels.items() if "INJECTION" in name or "JAILBREAK" in name), 1)


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


def _score_batch(texts: list[str]) -> list[float]:
    _tok.enable_padding(pad_id=_tok.token_to_id("[PAD]") or 0, pad_token="[PAD]")
    enc = _tok.encode_batch(texts)
    feeds = {
        "input_ids": np.array([e.ids for e in enc], dtype=np.int64),
        "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64),
    }
    if "token_type_ids" in _input_names:
        feeds["token_type_ids"] = np.array([e.type_ids for e in enc], dtype=np.int64)
    feeds = {k: v for k, v in feeds.items() if k in _input_names}
    logits = _session.run(None, feeds)[0]
    return _softmax(logits)[:, INJECTION_IDX].astype(float).tolist()


def handler(event, _context):
    chunks = event.get("chunks") or []
    if not isinstance(chunks, list) or not all(isinstance(c, str) for c in chunks):
        return {"error": "chunks must be a list of strings", "scores": None, "version": VERSION}
    scores: list[float] = []
    for i in range(0, len(chunks), BATCH):
        scores.extend(_score_batch(chunks[i : i + BATCH]))
    return {"scores": [round(s, 6) for s in scores], "version": VERSION}
