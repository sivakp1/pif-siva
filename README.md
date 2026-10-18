# PIF — LLM Prompt-Injection Firewall

A three-layer firewall between untrusted text and an LLM: L1 heuristics, an L2 ONNX classifier and an L3 LLM judge (Claude, via the Anthropic API or Amazon Bedrock). It runs on an AWS backend with a Next.js dashboard on Vercel. The specification is in [`specs/`](specs/).

| Folder | Contents |
|---|---|
| `core/` | `pif_core`: pure, deterministic detection logic (spec §4). No AWS. |
| `backend/lambdas/` | Python 3.12 Lambdas: authorizer, scan-orchestrator, classifier (container), admin-api, stats-aggregator, eval-runner tasks |
| `backend/infra/` | AWS CDK (TypeScript). Each of the `Dev` and `Prod` stages has five stacks: Core, Data, Api, Eval and Observability. cdk-nag is on. |
| `frontend/` | Next.js 15 dashboard (BFF pattern, Cognito login) |
| `eval/` | `pif_eval` CLI, the dataset builder, the 150-item smoke set and baselines |
| `specs/` | Spec documents, `openapi.yaml` and `traceability.md` |
| `.github/workflows/` | `ci.yml`, `deploy-backend.yml` and `ops.yml` |
| `infra-bootstrap/` | One-time CloudFormation template for the GitHub OIDC deploy role |

## Local development

```bash
python -m venv .venv && .venv/Scripts/activate      # Windows; use bin/activate on Linux/macOS
pip install -r requirements-dev.txt -e core -e eval
pytest                                              # core + backend (moto) + eval tests
python scripts/check_traceability.py                # every AC has a test
cd eval && python -m pif_eval gate --config L1 --baseline smoke/baseline.L1.json
```

To deploy, follow [DEPLOY.md](DEPLOY.md).

## Deviations from the spec

- **Classifier:** ProtectAI `deberta-v3-base-prompt-injection-v2`, the spec's alternative model (Apache-2.0, no gated download).
- **API Gateway:** HTTP APIs do not support X-Ray, so traces start at Lambda (BE-20).
- **Throttling:** HTTP APIs have no per-key usage plans, so throttling (50 rps, burst 100) is per stage, not per app (B.1).
- **Two HTTP APIs:** the data and control planes are separate APIs, so CORS applies only to the control plane (BE-23).
- **API-key authorizer:** it always authorizes and passes `auth_status` in the context, and the orchestrator returns the BE-05 401 envelope. HTTP APIs cannot customize authorizer error bodies.
- **Model provider:** the L3 judge and `/v1/chat` use Amazon Bedrock by default and can use the Anthropic API instead, with the same models: Bedrock IDs such as `us.anthropic.claude-haiku-4-5-20251001-v1:0` map to `claude-haiku-4-5`. To switch, set the SSM parameter `/pif/<stage>/llm_provider` to `anthropic` or `bedrock` (takes effect within 5 minutes, no deploy), or deploy with `PIF_LLM_PROVIDER=anthropic`. The Anthropic API key lives in the Secrets Manager secret `pif/<stage>/anthropic-api-key`, which is created with a placeholder that you replace with your key.
- **Dataset v1:** jailbreak prompts come from `jackhhao/jailbreak-classification` (a JailbreakBench substitute). Indirect attacks are synthetic BIPIA-style items. Both are recorded in the manifest.
