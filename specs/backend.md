# LLM Prompt-Injection Firewall — Backend Specification (AWS)

| Field | Value |
|---|---|
| Working name | **PIF** (Prompt-Injection Firewall) |
| Version | 1.0 (draft) |
| Date | 11 Oct 2026 |
| Status | Ready for planning (`/plan`) |
| Deployment | Backend on AWS, dashboard on Vercel |
| Scope | AWS backend: services, API, data model, observability, security, deployment |

Conventions used throughout:
- Requirements are numbered `CORE-xx`, `BE-xx`, `FE-xx`, `EVAL-xx` and `NFR-xx`. Acceptance criteria are numbered `AC-…`.
- **MUST**, **SHOULD** and **MAY** follow RFC 2119 meaning.
- Every `AC-…` maps to at least one automated test (see [spec.md](spec.md) §7, Traceability).
- Values marked *(configurable)* are defaults that a per-app policy or environment setting can change.

This file is part of the PIF specification. Principles (P1–P9), core requirements (`CORE-xx`), evaluation (`EVAL-xx`), NFRs and the traceability matrix are in [spec.md](spec.md).

| Document | Contents |
|---|---|
| [spec.md](spec.md) | Overview, principles, architecture, core detection logic, evaluation, NFRs, traceability |
| [backend.md](backend.md) | AWS services, API, data model, observability, security, deployment |
| [frontend.md](frontend.md) | Vercel dashboard: stack, BFF, pages, safe rendering, accessibility |

---

## Backend (AWS)

### B.1 Components

| Component | Service | Runtime / config | Responsibility |
|---|---|---|---|
| `api` | API Gateway HTTP API | Throttling 50 rps burst 100 per app *(configurable)* | Routing, auth, throttling |
| `authorizer` | Lambda (Python 3.12) | 256 MB, result cache 300 s | Validate `x-api-key` → `app_id` |
| `scan-orchestrator` | Lambda (Python 3.12) | 1,024 MB, timeout 10 s, `pif_core` layer | `/v1/scan`, `/v1/chat`; runs L1, calls L2/L3, logs verdicts |
| `classifier` | Lambda container image | 3,008 MB, timeout 10 s, provisioned concurrency 1 (prod) | ONNX inference, returns chunk scores |
| `admin-api` | Lambda (Python 3.12) | 512 MB | All `/v1/admin/*` routes |
| `stats-aggregator` | Lambda, DynamoDB Streams trigger | batch 100 | Maintains daily counters |
| `eval-runner` | Step Functions (Standard) + Lambdas | Map concurrency 5 | Executes evaluation runs |
| Judge / downstream LLM | Amazon Bedrock (Converse API) | Model IDs in SSM parameters | L3 judge; proxy-mode completions |
| Baseline | Bedrock Guardrails (`ApplyGuardrail`) | Prompt-attack filter = HIGH | Evaluation baseline only |
| Storage | DynamoDB (on-demand), S3 | KMS CMK encryption | See B.3 |
| Identity | Cognito User Pool | Groups `admin`, `analyst` | Dashboard users; JWT authorizer |
| Secrets | Secrets Manager | — | HMAC pepper for input hashing |
| Observability | CloudWatch (EMF), X-Ray | — | Metrics, logs, traces, alarms |
| IaC | AWS CDK (TypeScript) | Stacks: `Core`, `Data`, `Api`, `Eval`, `Observability` | All infrastructure |

### B.2 API

#### B.2.1 Authentication

`BE-01` **Data plane** (`/v1/scan`, `/v1/chat`):
- Callers send header `x-api-key: pif_live_<32 random chars>`.
- PIF stores only the SHA-256 hash of the key plus its first 12 characters for display.
- The authorizer looks the key up by hash and injects `app_id` into the request context.
- The `app_id` in the request body MUST match the key's app, or the request fails with 403.

`BE-02` **Control plane** (`/v1/admin/*`):
- API Gateway's JWT authorizer validates Cognito access tokens.
- `analyst` may call GET routes only.
- `admin` may call every route.
- Authorization is enforced in `admin-api` from the `cognito:groups` claim.

#### B.2.2 Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/scan` | API key | Scan input and context, return verdict |
| POST | `/v1/chat` | API key | Scan input, call the LLM, check output, return response or refusal |
| GET | `/healthz` | none | Liveness (no dependencies checked) |
| POST | `/v1/admin/playground/scan` | JWT (analyst+) | Same as scan, for a chosen app's policy; `origin=playground` |
| GET | `/v1/admin/verdicts` | JWT (analyst+) | List verdicts (filters, cursor pagination) |
| GET | `/v1/admin/verdicts/{verdict_id}` | JWT (analyst+) | Verdict detail |
| GET | `/v1/admin/stats` | JWT (analyst+) | Aggregates for analytics |
| GET | `/v1/admin/apps` | JWT (analyst+) | List apps |
| POST | `/v1/admin/apps` | JWT (admin) | Create app; returns API key **once** |
| POST | `/v1/admin/apps/{app_id}/rotate-key` | JWT (admin) | New key; old key valid for 24 h *(configurable)* |
| GET | `/v1/admin/apps/{app_id}/policy` | JWT (analyst+) | Read policy and `policy_version` |
| PUT | `/v1/admin/apps/{app_id}/policy` | JWT (admin) | Update policy (optimistic concurrency) |
| GET | `/v1/admin/datasets` | JWT (analyst+) | List evaluation dataset versions |
| POST | `/v1/admin/eval-runs` | JWT (admin) | Start evaluation run |
| GET | `/v1/admin/eval-runs` | JWT (analyst+) | List runs |
| GET | `/v1/admin/eval-runs/{run_id}` | JWT (analyst+) | Run status, metrics, result links |

`BE-03` An OpenAPI 3.1 document (`/specs/openapi.yaml`) MUST be generated from or kept in sync with these schemas. Contract tests validate deployed responses against it.

#### B.2.3 `POST /v1/scan`

Request:

```json
{
  "app_id": "support-bot",
  "input": "Summarize this page",
  "context_docs": [
    { "id": "kb-17", "content": "<html>…</html>", "source_type": "web", "content_type": "html" }
  ],
  "options": { "return_sanitized": true, "explain": true },
  "metadata": { "session_ref": "opaque-string", "user_ref": "opaque-string" }
}
```

- At least one of `input` or `context_docs` MUST be present.
- A `context_docs` element MAY be a plain string. It is then treated as `{source_type:"rag", content_type:"text"}`.
- `metadata` values are hashed before storage.

Response: `200` with the ScanResult ([spec.md](spec.md) A.10) plus `verdict_id` (ULID) and `request_id`. With `explain=false`, judge reasons and per-layer details are omitted, but finding categories remain.

#### B.2.4 `POST /v1/chat`

Request:

```json
{
  "app_id": "support-bot",
  "system": "You are a support assistant for ShopKart…",
  "messages": [ { "role": "user", "content": "Summarize this page" } ],
  "context_docs": [ … ],
  "model_params": { "max_tokens": 800, "temperature": 0.2 }
}
```

`BE-04` Processing steps:
1. Scan the last user message and all `context_docs`.
2. If the action is BLOCK, return a refusal and do not call the LLM.
3. Otherwise, build the prompt: original system prompt, then the spotlight instruction ([spec.md](spec.md) CORE-29), then the canary ([spec.md](spec.md) CORE-30), then the sanitized context, then the messages.
4. Call Bedrock Converse with the app's configured model.
5. Run output checks ([spec.md](spec.md) A.9).
6. Return the response:

```json
{ "verdict_id": "…", "action": "allow|flag|sanitize|block",
  "input_verdict": { …ScanResult… }, "output_verdict": { …ScanResult… },
  "output": "model text or null",
  "refusal": "I can't help with that request." }
```

If the output check blocks, `output` is `null` and `refusal` is set.

#### B.2.5 Errors and limits

`BE-05` All errors use this shape: `{ "error": { "code": "...", "message": "...", "request_id": "..." } }`

| HTTP | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Schema violation (message names the field) |
| 401 | `UNAUTHORIZED` | Missing or invalid key or JWT |
| 403 | `FORBIDDEN` | `app_id` mismatch, or role not permitted |
| 404 | `NOT_FOUND` | Unknown verdict, app or run |
| 409 | `CONFLICT` | Stale `policy_version` on PUT |
| 413 | `PAYLOAD_TOO_LARGE` | CORE-03 limits |
| 429 | `RATE_LIMITED` | Throttled; includes `Retry-After` |
| 503 | `DETECTOR_UNAVAILABLE` | Pipeline failure with `fail_mode=closed` |
| 500 | `INTERNAL` | Unexpected; never leaks stack traces |

### B.3 Data model

`BE-06` **Table `pif-apps`**

| Attribute | Type | Notes |
|---|---|---|
| `app_id` (PK) | S | slug, 3–40 chars `[a-z0-9-]` |
| `name` | S | |
| `key_hash` | S | SHA-256 of the API key; GSI `by-key-hash` |
| `key_prefix` | S | first 12 chars, for display |
| `prev_key_hash`, `prev_key_expires_at` | S | supports rotation |
| `policy` | M | A.7 schema ([spec.md](spec.md)) |
| `policy_version` | N | incremented on every update |
| `allowed_link_domains` | SS | for CORE-31 |
| `chat_model_id` | S | Bedrock model for proxy mode |
| `status` | S | `active` or `disabled` |
| `created_at`, `updated_at`, `updated_by` | S | ISO 8601; `updated_by` = Cognito `sub` |

`BE-07` **Table `pif-verdicts`**

| Attribute | Type | Notes |
|---|---|---|
| `pk` | S | `APP#{app_id}` |
| `sk` | S | `TS#{iso8601}#{verdict_id}` |
| `verdict_id` | S | ULID; GSI `by-id` (PK) |
| `gsi_action_pk` | S | `APP#{app_id}#ACT#{action}`; GSI `by-action` (PK), `sk` as SK |
| `action`, `would_action`, `risk_score`, `degraded`, `mode` | — | |
| `origin` | S | `api`, `chat` or `playground` |
| `categories` | SS | finding categories |
| `segments_summary` | L | per segment: `ref`, `source`, `risk`, `action`, layer scores, judge label and reason |
| `findings` | L | as A.10, without raw text beyond the snippet |
| `input_hash` | S | HMAC-SHA256(pepper, normalized input) |
| `snippet` | S | ≤ 200 chars, PII-redacted (BE-08) |
| `latency_ms` | M | |
| `versions` | M | |
| `ttl` | N | now + 30 days *(configurable)* |

DynamoDB Streams (NEW_IMAGE) on this table feed `stats-aggregator`.

`BE-08` **PII redaction** for snippets runs before storage using regex detectors for:
- email addresses
- phone numbers (including Indian +91 formats)
- payment card numbers (Luhn-validated)
- 12-digit Aadhaar-like numbers
- AWS access keys (`AKIA…`)
- JWTs
- URLs with query strings

Matches are replaced with `[EMAIL]`, `[PHONE]` and similar tokens.

`BE-09` **Table `pif-stats`**
- `pk` = `APP#{app_id}`, `sk` = `DAY#{yyyy-mm-dd}#HOUR#{hh}`.
- Counters (atomic `ADD`): `total`, `allow`, `flag`, `sanitize`, `block`, `degraded`, `judge_calls`, `cat_{category}`.
- Latency: a fixed-bucket latency histogram (`lat_b{0..11}` with log-spaced bucket edges), so the API can approximate p50 and p95.
- Playground verdicts are counted separately under `pk = APP#{app_id}#PLAYGROUND`.

`BE-10` **Table `pif-eval-runs`**
- `run_id` (PK, ULID), `status` (`queued`, `running`, `succeeded` or `failed`), `dataset_version`, `configs` (list), `thresholds_sweep` (bool), `metrics` (map per config; summary only), `s3_prefix`, `created_by`, `created_at`, `finished_at`, `error`.

`BE-11` **S3 bucket `pif-eval-{account}`** (KMS-encrypted, block public access, versioning on):

```
datasets/{dataset_version}/manifest.json
datasets/{dataset_version}/items.jsonl
runs/{run_id}/config.json
runs/{run_id}/predictions/{config}.jsonl
runs/{run_id}/results.json
```

### B.4 Processing behavior

`BE-12` **Policy caching.** The orchestrator caches each app's policy in memory for 60 s *(configurable)*. A policy update is therefore effective within 60 s with no redeploy.

`BE-13` **Layer invocation.**
- The orchestrator runs L1 in-process.
- It invokes `classifier` synchronously with all chunks of all segments in one call (batching).
- It calls Bedrock for judge calls in parallel, up to the judge budget.

`BE-14` **Verdict logging.**
- Verdicts are written with a single `PutItem` after the response is computed.
- A failed write MUST NOT fail the scan. It emits the metric `VerdictWriteErrors` and logs the `verdict_id`.

`BE-15` **Playground scans** use the selected app's policy and are rate-limited to 30 per minute per user. They are logged with `origin=playground` and excluded from default analytics.

`BE-16` **Key rotation.** After rotation, both keys authenticate until `prev_key_expires_at`, after which the old key returns 401.

### B.5 Observability

`BE-17` Metrics are emitted with CloudWatch EMF, namespace `PIF`, dimension `AppId`:
- `ScanLatencyMs`
- `LayerLatencyMs{Layer}`
- `Actions{Action}`
- `JudgeInvocations`
- `JudgeErrors`
- `ClassifierErrors`
- `Degraded`
- `VerdictWriteErrors`

`BE-18` Logs are structured JSON with `request_id`, `verdict_id`, `app_id`, `action`, `risk_score`, `latency_ms` and `versions`. Logs MUST NOT contain raw input or output text (P1).

`BE-19` Alarms, notified to an SNS topic:
- warm p95 `ScanLatencyMs` > 500 ms for 5 minutes
- 5xx rate > 2% over 5 minutes
- `JudgeErrors` / `JudgeInvocations` > 10% over 10 minutes
- `Degraded` > 5% over 10 minutes

`BE-20` X-Ray tracing is enabled on API Gateway and all Lambdas. Bedrock and classifier calls appear as subsegments.

### B.6 Security

`BE-21` IAM (P5):
- `scan-orchestrator` may invoke only the `classifier` function and the configured Bedrock model ARNs. It may `GetItem` on `pif-apps` and `PutItem` on `pif-verdicts`.
- `admin-api` has no Bedrock permissions except through the playground path. That path invokes `scan-orchestrator`, not Bedrock directly.

`BE-22` Encryption:
- All tables and buckets use a customer-managed KMS key.
- TLS 1.2 or later is required.
- The HMAC pepper lives in Secrets Manager and is cached for 5 minutes.

`BE-23` CORS on the control plane allows only the Vercel production and preview domains. The data plane has no CORS, because it is server-to-server.

`BE-24` CI runs dependency scanning (pip-audit, npm audit), IaC scanning (cdk-nag) and secret scanning (gitleaks). High-severity findings fail the build.

### B.7 Environments and deployment

`BE-25` There are two environments, `dev` and `prod`, deployed as separate CDK stage instances. Model IDs, thresholds and TTLs come from SSM Parameter Store at `/pif/{env}/…`.

`BE-26` GitHub Actions deploys through OIDC federation (no long-lived AWS keys):
- push to `main` → deploy `dev` → run integration and contract tests → run the evaluation smoke gate ([spec.md](spec.md) EVAL-07) → manual approval → deploy `prod`.

### B.8 Backend acceptance criteria

- **AC-BE-1** Given a valid key for app A and `app_id: "B"` in the body, when calling `/v1/scan`, then the response is 403 `FORBIDDEN`.
- **AC-BE-2** Given a 70 KB body, then the response is 413 `PAYLOAD_TOO_LARGE`, and no verdict is stored.
- **AC-BE-3** Given a known injection (fixture 2), when calling `/v1/scan`, then the response is 200 with `action="block"`, a `verdict_id`, and the stored item has no attribute containing the substring "discount codes" beyond the ≤ 200-char redacted snippet.
- **AC-BE-4** Given an input containing `test@example.com`, then the stored `snippet` contains `[EMAIL]` and not the address.
- **AC-BE-5** Given an admin updates a policy threshold, when 60 s have passed, then scans reflect the new threshold without redeploying.
- **AC-BE-6** Given two PUTs to the same policy with the same `policy_version`, then exactly one succeeds and the other returns 409.
- **AC-BE-7** Given an `analyst` JWT, when calling `PUT …/policy`, then 403 is returned.
- **AC-BE-8** Given `/v1/chat` with a context document whose output leaks the canary (mocked LLM), then `output=null`, `action="block"`, and a `prompt_extraction` finding exists.
- **AC-BE-9** Given the classifier Lambda is disabled and `fail_mode=closed` with the judge disabled, when scanning, then the response is 503 `DETECTOR_UNAVAILABLE`. With `fail_mode=open`, the response is 200 with `degraded=true`.
- **AC-BE-10** Given a rotated key, then the old key works before `prev_key_expires_at` and returns 401 after it.
- **AC-BE-11** Given 1,000 benign requests at 20 rps against warm `prod`, then p95 latency ≤ 300 ms for requests that did not invoke the judge.
- **AC-BE-12** Given any scan, then the CloudWatch log line contains no field holding input or output text.
- **AC-BE-13** Given a deployed stack, then cdk-nag reports no unsuppressed errors, and every suppression has a written justification.
