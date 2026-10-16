# LLM Prompt-Injection Firewall — Frontend Specification (Vercel)

| Field | Value |
|---|---|
| Working name | **PIF** (Prompt-Injection Firewall) |
| Version | 1.0 (draft) |
| Date | 11 Oct 2026 |
| Status | Ready for planning (`/plan`) |
| Deployment | Backend on AWS, dashboard on Vercel |
| Scope | Vercel dashboard: stack, BFF, pages, cross-cutting UI requirements |

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

## Frontend (Vercel)

### C.1 Stack

`FE-01` The dashboard uses:
- Next.js 15 (App Router), TypeScript in strict mode
- Tailwind CSS and shadcn/ui components
- Recharts for charts, TanStack Table for tables
- Zod for validation
- Auth.js (NextAuth) with the Cognito provider (OAuth authorization code + PKCE)

It is deployed on Vercel with Git integration: preview deployments per PR and production from `main`.

`FE-02` **Backend-for-frontend (BFF).** The browser calls only same-origin route handlers under `/api/*`. Route handlers:
1. read the user's session,
2. attach the Cognito access token,
3. call the control plane at `PIF_API_BASE_URL` (server-only environment variable), and
4. validate both request and response bodies with Zod.

No API key or token is exposed to client JavaScript, and no `NEXT_PUBLIC_*` variable holds a secret.

### C.2 Roles and navigation

`FE-03` After login the user's role comes from the Cognito groups claim.
- `analyst` sees every page read-only.
- Admin-only controls are hidden from analysts **and** enforced server-side ([backend.md](backend.md) BE-02).

Navigation: **Playground · Verdicts · Analytics · Apps · Evaluation**, with a user menu (role badge, sign out).

### C.3 Pages

#### C.3.1 `/login`

`FE-04` Shows a sign-in button that redirects to the Cognito Hosted UI. Unauthenticated access to any other route redirects here and preserves `callbackUrl`.

#### C.3.2 `/playground`

`FE-05` Inputs:
- app selector (applies that app's policy)
- **User input** textarea
- **Context documents**: add or remove; each has a content textarea, `source_type` select and `content_type` select (text, html or markdown)
- toggle "Run judge" (overrides `judge_enabled` for this scan only)
- **Presets** dropdown loaded with the A.11 examples in [spec.md](spec.md) (benign order question, override, rephrased override, hidden-HTML page, student question, base64)

`FE-06` The result panel shows:
- **Action badge**, with fixed colors and text labels (never color alone): ALLOW green, FLAG amber, SANITIZE blue, BLOCK red. In monitor mode it reads "ALLOW (would BLOCK)".
- **Risk score** as a number and a horizontal bar marked with the flag, sanitize and block thresholds.
- **Layer table**, one row per segment, with columns heuristic score and matched rule IDs, classifier score, judge label, confidence and reason, segment action. "—" marks layers that did not run, with a tooltip explaining why (e.g., "not in gray zone").
- **Findings list**: category, severity, layer and reason. Spans are highlighted in the original text using offsets (see FE-14).
- **Sanitized output**: a side-by-side view of original and sanitized text for each context document.
- **Latency** breakdown: total, L1, L2, L3.
- **Raw JSON**: a collapsible, copyable view of the full response.

`FE-07` States:
- While scanning: spinner, and the submit button is disabled.
- On 429: "Rate limit reached — try again in N s".
- On 413: an error message naming the limit.
- Empty state: a short explainer of the three layers, with a link to the presets.

#### C.3.3 `/verdicts`

`FE-08` A table with columns: time (local, relative on hover), app, action badge, risk, categories (chips), snippet (redacted, single line, truncated), latency, degraded icon.
- Filters: app, action (multi-select), time range (1 h, 24 h, 7 d, custom), minimum risk, origin (API, chat, playground; playground off by default).
- Filters live in the URL query string so views can be shared.
- Pagination is cursor-based ("Load more").
- Optional auto-refresh every 10 s, off by default.

#### C.3.4 `/verdicts/[id]`

`FE-09` Shows every stored field, laid out like the playground result panel. Raw text is not stored, so the page shows the snippet and `input_hash`, along with a note: "Full input is not retained by design (privacy policy P1)." It also shows versions (core, rules, classifier, judge, policy) and a link to the app's policy.

#### C.3.5 `/analytics`

`FE-10` Controls: app selector (or "All apps") and time range.
- **KPI tiles**: total requests, block rate %, flag rate %, judge escalation rate %, p95 latency, degraded rate %.
- **Charts**:
  1. requests by action over time (stacked bar by hour or day)
  2. block rate % over time (line)
  3. top finding categories (horizontal bar)
  4. p50/p95 latency over time (line)
  5. judge escalation rate over time (line)
- Every chart has an accessible data-table alternative ("View as table").

#### C.3.6 `/apps` and `/apps/[id]`

`FE-11` The list view shows app ID, name, status, key prefix, mode, `policy_version` and last updated.

Admin actions:
- **Create app**: form for ID, name, chat model and allowed link domains. On success, a modal shows the API key **once** with a copy button and the warning "This key will not be shown again."
- **Rotate key**: confirmation dialog that states the grace period, then shows the new key once.
- **Disable app**.

`FE-12` **Policy editor** (`/apps/[id]`, Policy tab):
- form fields for every A.7 policy field ([spec.md](spec.md))
- sliders with numeric inputs for thresholds and the gray zone
- tag inputs for deny phrases, allow phrases and allowed link domains

Validation:
- Client-side Zod mirrors CORE-22 ([spec.md](spec.md)) and gives inline errors (e.g., "Flag threshold must be ≤ Sanitize threshold").
- Saving sends `policy_version`. On 409, show "This policy was changed by someone else" and offer to reload.
- A **diff preview** shows changed fields before saving.
- Mode `monitor` shows an info banner explaining that nothing is blocked in this mode.

#### C.3.7 `/evaluation` and `/evaluation/[runId]`

`FE-13` **Runs list**: run ID, dataset version, configurations, status (with a live poll every 5 s while running), created by and when, headline F1 and FPR.

Admin action **New run**:
- dataset version select
- configuration checkboxes: `L1`, `L1+L2`, `L1+L2+L3`, `bedrock_guardrails`
- "Threshold sweep" toggle

**Run detail** shows:
- a metrics table with one row per configuration: precision, recall, F1, FPR, p50/p95 latency, judge escalation rate, estimated cost per 1,000 requests
- a confusion matrix per configuration
- per-category recall (grouped bar by configuration)
- a precision–recall curve from the threshold sweep, with the current default threshold marked
- a misclassified-items table (false positives and false negatives) with full text, which is allowed because evaluation data is public or synthetic, rendered as plain text
- download links for `results.json` and predictions JSONL

### C.4 Cross-cutting frontend requirements

`FE-14` **Safe rendering (P7).** All attack text, snippets, judge reasons and evaluation items MUST be rendered as React text nodes. Specifically:
- No `dangerouslySetInnerHTML`, no markdown rendering, no auto-linking.
- Span highlights are built by splitting the string at the offsets and wrapping substrings in `<mark>`.
- A lint rule (`react/no-danger`) is set to error.

`FE-15` **Security headers** (set in `next.config` / middleware):
- CSP `default-src 'self'; script-src 'self' 'nonce-…'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- HSTS

Images from verdict data are never loaded.

`FE-16` **Sessions** use httpOnly, Secure, SameSite=Lax cookies. Auth.js CSRF protection is enabled. Sessions expire after 8 h idle *(configurable)*.

`FE-17` **Accessibility:** WCAG 2.1 AA, meaning keyboard-navigable, labeled inputs, contrast ≥ 4.5:1, and action never conveyed by color alone. **Responsive:** usable at a width of 375 px or more. Tables scroll horizontally inside their container, never the page.

`FE-18` **Error handling:** a BFF error maps to a toast plus an inline message that shows `request_id` so it can be reported. Unexpected errors render an error boundary with a retry action.

`FE-19` **Performance:** on Vercel production, the initial load of `/verdicts` has LCP ≤ 2.5 s on a typical 4G connection. Pages use React Server Components for initial data where possible.

### C.5 Frontend acceptance criteria

- **AC-FE-1** Given an unauthenticated user visits `/analytics`, then they are redirected to `/login?callbackUrl=/analytics`.
- **AC-FE-2** Given an analyst session, then the "Create app", "Rotate key", "Save policy" and "New run" controls are not rendered. A direct POST to `/api/apps` returns 403.
- **AC-FE-3** Given preset "Hidden-HTML page" in the playground with the judge on, then the result shows action SANITIZE, a `hidden_instruction` finding, a judge reason, and a sanitized document whose text no longer contains the hidden sentence.
- **AC-FE-4** Given the input `<img src=x onerror=alert(1)>` in the playground, then it is displayed literally as text, and no script executes (Playwright asserts that no dialog appears).
- **AC-FE-5** Given the policy editor with flag = 0.9 and sanitize = 0.7, then Save is disabled and an inline error names both fields.
- **AC-FE-6** Given a policy changed in another tab, when saving, then a conflict message appears and no change is applied.
- **AC-FE-7** Given app creation succeeds, then the key is shown once. After the modal is closed, the key appears nowhere in the UI, local storage or the page source.
- **AC-FE-8** Given filters on `/verdicts`, when the page URL is copied to a new tab, then the same filters are applied.
- **AC-FE-9** Given the client bundle, when searched for `PIF_API_BASE_URL`, `pif_live_` and the AWS account ID, then there are no matches.
- **AC-FE-10** Given an axe-core scan of each page, then there are no serious or critical violations.
