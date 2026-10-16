# PIF dashboard (frontend)

Next.js 15 (App Router) dashboard for the Prompt-Injection Firewall, deployed on Vercel.
Spec: `frontend.md` (FE-01…FE-19, AC-FE-1…10). API contract: `backend.md` B.2 and `spec.md` A.7/A.10/A.11.

## Architecture

```
browser ──same-origin──▶ /api/*  (route handlers = BFF, server only)
                              │  session cookie (encrypted Auth.js JWT) → Cognito access token
                              ▼
                 ${PIF_API_BASE_URL}/v1/admin/*   (API Gateway JWT authorizer)
```

- **Auth** (`auth.ts`): Auth.js v5 with the Cognito provider, authorization code + PKCE (+ state, nonce).
  The access and refresh tokens live only in the encrypted, httpOnly, SameSite=Lax session cookie.
  The browser session exposes only name, email and `role`. The role comes from the `cognito:groups`
  claim (`admin` > `analyst`). Sessions expire after 8 h idle (`maxAge` 8 h, sliding `updateAge` 5 min).
  Access tokens are refreshed with the refresh token shortly before they expire.
- **Middleware** (`middleware.ts`): redirects unauthenticated page requests to
  `/login?callbackUrl=<path>` (AC-FE-1) and returns a 401 envelope for `/api/*`. It sets a per-request
  CSP nonce plus `nosniff`, `Referrer-Policy`, HSTS and `frame-ancestors 'none'` (FE-15).
- **BFF** (`lib/bff.ts`, `app/api/**`): every handler reads the session, checks the role for admin-only
  mutations (analysts get 403 before the backend is called, AC-FE-2), validates the request body
  and query with Zod (`lib/schemas.ts`), calls the control plane with `Authorization: Bearer`,
  validates the response, and passes through the `{error:{code,message,request_id}}` envelope and
  `Retry-After`. Mutations also reject cross-origin `Origin` headers.
- **Pages** (`app/(dashboard)/**`): Playground, Verdicts (+ detail), Analytics, Apps (+ Policy tab),
  Evaluation (+ run detail). Verdicts, Apps and Evaluation render their initial data with React
  Server Components (`lib/server-api.ts`), which go through the same validation path.
- **Safe rendering** (FE-14): untrusted text is only ever rendered as React text nodes. Span highlights
  split strings at code-point offsets (`lib/highlight.ts`) and wrap pieces in `<mark>`.
  ESLint enforces `react/no-danger: error`, and client components may not read `process.env`.

| Route handler | Method | Control-plane call | Role |
|---|---|---|---|
| `/api/playground/scan` | POST | `POST /v1/admin/playground/scan` | analyst+ |
| `/api/verdicts` | GET | `GET /v1/admin/verdicts` | analyst+ |
| `/api/verdicts/[id]` | GET | `GET /v1/admin/verdicts/{verdict_id}` | analyst+ |
| `/api/stats` | GET | `GET /v1/admin/stats` | analyst+ |
| `/api/apps` | GET / POST | `GET` / `POST /v1/admin/apps` | analyst+ / admin |
| `/api/apps/[id]` | PATCH | `PATCH /v1/admin/apps/{app_id}` `{status}` | admin |
| `/api/apps/[id]/rotate-key` | POST | `POST /v1/admin/apps/{app_id}/rotate-key` | admin |
| `/api/apps/[id]/policy` | GET / PUT | `GET` / `PUT /v1/admin/apps/{app_id}/policy` | analyst+ / admin |
| `/api/datasets` | GET | `GET /v1/admin/datasets` | analyst+ |
| `/api/eval-runs` | GET / POST | `GET` / `POST /v1/admin/eval-runs` | analyst+ / admin |
| `/api/eval-runs/[runId]` | GET | `GET /v1/admin/eval-runs/{run_id}` (+ `results.json` from its presigned S3 URL) | analyst+ |

The response shapes the dashboard expects are the Zod schemas in `lib/schemas.ts`. They accept extra fields.

## Environment variables

All of them are server-only. None may use the `NEXT_PUBLIC_` prefix. See `.env.example`.

| Variable | Required | Purpose |
|---|---|---|
| `PIF_API_BASE_URL` | yes | Control-plane base URL, e.g. `https://abc123.execute-api.us-east-1.amazonaws.com` |
| `AUTH_SECRET` | yes | Encrypts the session JWT (`npx auth secret`) |
| `AUTH_COGNITO_ID` | yes | Cognito app client ID |
| `AUTH_COGNITO_SECRET` | yes | Cognito app client secret |
| `AUTH_COGNITO_ISSUER` | yes | `https://cognito-idp.us-east-1.amazonaws.com/<user-pool-id>` |
| `AUTH_URL` | no | Canonical URL. Leave it unset on Vercel |
| `AUTH_TRUST_HOST` | yes on Vercel | `true` |

Cognito app client settings: authorization code grant, scopes `openid email profile`, and callback
URL `https://<host>/api/auth/callback/cognito` (plus `http://localhost:3000/api/auth/callback/cognito`
for local dev). Users must be in the `admin` or `analyst` group.

## Scripts

```bash
npm install          # first time; commit the generated package-lock.json
npm run dev          # http://localhost:3000
npm run lint         # next lint (react/no-danger = error), zero warnings allowed
npm run typecheck    # tsc --noEmit (strict)
npm run test         # vitest unit tests (policy validation AC-FE-5, span highlighting, URL filters)
npm run build        # next build
npm run check:bundle # after build: AC-FE-9 search of .next/static for secrets
npm run e2e          # Playwright + axe against E2E_BASE_URL (see below)
```

### Dependency audit (BE-24)

`npm audit --omit=dev` reports 0 vulnerabilities. Next's bundled `postcss` is overridden to a patched
version in `package.json` `overrides`. The full `npm audit` still lists high-severity issues in
dev-only build tooling: `braces` (every published version is affected, pulled in by Tailwind 3 and
`eslint-config-next`) and `postcss-selector-parser` (from Tailwind 3). Gate CI on
`npm audit --omit=dev --audit-level=high`.

## E2E tests

`e2e/acceptance.spec.ts` has one or more tests per acceptance criterion, named `test_AC_FE_1` …
`test_AC_FE_10`. They run against any deployment:

```bash
npx playwright install chromium
E2E_BASE_URL=https://<preview>.vercel.app \
E2E_ADMIN_USERNAME=... E2E_ADMIN_PASSWORD=... \
E2E_ANALYST_USERNAME=... E2E_ANALYST_PASSWORD=... \
E2E_APP_ID=e2e-app E2E_AWS_ACCOUNT_ID=123456789012 \
npm run e2e
```

- `e2e/auth.setup.ts` signs in through the Cognito Hosted UI once per role and stores the session in
  `e2e/.auth/` (git-ignored). Tests for a role are skipped when its credentials are not set.
- AC-FE-6 edits the `judge_budget` of `E2E_APP_ID` and then restores it. AC-FE-7 creates an app named
  `e2e-<timestamp>` and disables it afterwards.
- AC-FE-3 needs the deployed pipeline to return SANITIZE for the "Hidden-HTML page" preset.

## Vercel

Set the project's **Root Directory** to `frontend`. Production deploys from `main`, and each PR gets a
preview deployment. Add the environment variables for Production and Preview. Preview URLs must also
be allowed by the control plane's CORS settings and the Cognito callback URLs.

## Assumptions about the backend contract

These are documented here so the backend can match them:

- Playground scan request: `{app_id, input?, context_docs:[{id, content, source_type, content_type}],
  options:{return_sanitized, explain, judge_enabled?}}`. `options.judge_enabled` overrides the policy
  for that scan only.
- Layer objects in a ScanResult may carry `skipped_reason` (`not_in_gray_zone`, `judge_disabled`,
  `budget_exhausted`, `output_segment`, `timeout`, `error`, `not_requested`). If it is missing, the UI
  works out a reason from the policy's gray zone.
- List responses: `{items, next_cursor}` for verdicts, `{apps}`, `{datasets}`, `{runs}`.
  `POST /apps` returns `{app, api_key}`. `rotate-key` returns `{api_key, prev_key_expires_at}`.
- `PUT /policy` takes `{policy, policy_version, allowed_link_domains?}` and returns
  `{policy, policy_version, ...}`.
- Stats: `{granularity, buckets:[{ts,total,allow,flag,sanitize,block,degraded,judge_calls,p50_ms,p95_ms}],
  categories:[{category,count}] | {category: count}, totals?}`.
- Eval run detail: run fields plus `metrics{config:{tp,fp,tn,fn,precision,recall,f1,fpr,fpr_hard,p50_ms,
  p95_ms,judge_escalation_rate,cost_per_1k,per_category_recall}}`, `results_url`, `predictions_urls{config:url}`,
  and optionally `sweep{config:[{threshold,precision,recall,fpr}]}`, `misclassified[]` and
  `default_threshold`. If those optional fields are missing, the BFF reads them from `results.json`.
