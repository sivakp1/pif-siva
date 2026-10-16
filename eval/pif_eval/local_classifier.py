"""Local ONNX classifier mirroring backend/lambdas/classifier/app.py (EVAL-08).

Requires: pip install onnxruntime tokenizers numpy, and the model files from
protectai/deberta-v3-base-prompt-injection-v2 (onnx/model.onnx, tokenizer.json, config.json).
"""

from __future__ import annotations

import json
from pathlib import Path


class OnnxClassifier:
    def __init__(self, model_dir: str | Path, version: str = "protectai-deberta-v3-base-pi-v2-onnx-1"):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        model_dir = Path(model_dir)
        self.np = np
        self.version = version
        self.session = ort.InferenceSession(str(model_dir / "model.onnx"), providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}
        self.tok = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.tok.enable_truncation(max_length=512)
        labels = {int(k): v.upper() for k, v in json.loads((model_dir / "config.json").read_text()).get("id2label", {}).items()}
        self.idx = next((i for i, n in labels.items() if "INJECTION" in n), 1)

    def score(self, chunks: list[str]) -> list[float]:
        np = self.np
        out: list[float] = []
        for i in range(0, len(chunks), 8):
            batch = chunks[i : i + 8]
            self.tok.enable_padding(pad_id=self.tok.token_to_id("[PAD]") or 0, pad_token="[PAD]")
            enc = self.tok.encode_batch(batch)
            feeds = {
                "input_ids": np.array([e.ids for e in enc], dtype=np.int64),
                "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64),
                "token_type_ids": np.array([e.type_ids for e in enc], dtype=np.int64),
            }
            logits = self.session.run(None, {k: v for k, v in feeds.items() if k in self.inputs})[0]
            e = np.exp(logits - logits.max(axis=-1, keepdims=True))
            probs = e / e.sum(axis=-1, keepdims=True)
            out.extend(round(float(p), 6) for p in probs[:, self.idx])
        return out
