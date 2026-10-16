# L2 classifier: ProtectAI deberta-v3-base-prompt-injection-v2 (Apache-2.0), ONNX on CPU.
# The model is downloaded at image build time and pinned to a Hugging Face revision.
FROM public.ecr.aws/lambda/python:3.12 AS model
ARG HF_REPO=protectai/deberta-v3-base-prompt-injection-v2
ARG HF_REVISION=main
RUN mkdir -p /opt/model && \
    for f in onnx/model.onnx onnx/tokenizer.json onnx/config.json; do \
      curl -fsSL --retry 3 -o /opt/model/$(basename $f) "https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${f}"; \
    done && \
    sha256sum /opt/model/* > /opt/model/SHA256SUMS

FROM public.ecr.aws/lambda/python:3.12
COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt
COPY --from=model /opt/model /opt/model
COPY app.py ${LAMBDA_TASK_ROOT}/
ENV MODEL_DIR=/opt/model \
    CLASSIFIER_VERSION=protectai-deberta-v3-base-pi-v2-onnx-1 \
    OMP_NUM_THREADS=2
CMD ["app.handler"]
