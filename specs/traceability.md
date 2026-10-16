# Traceability matrix (spec.md §7)

`scripts/check_traceability.py` runs in CI and fails if any `AC-…` in `specs/*.md` has no test or CI step whose name contains it.

| User story | Requirements | Acceptance criteria | Test(s) |
|---|---|---|---|
| US-01 | CORE-01…26, BE-01, BE-03, BE-05 | AC-CORE-1…9, AC-BE-1…3 | `core/tests/test_fixtures.py`, `core/tests/test_core_acs.py`, `backend/tests/unit/test_scan.py`, `backend/tests/integration/test_deployed.py` |
| US-02 | CORE-27…29 | AC-CORE-10, AC-FE-3 | `core/tests/test_sanitize.py`, `frontend/e2e/*.spec.ts` |
| US-03 | CORE-30…32, BE-04 | AC-BE-8 | `backend/tests/unit/test_chat_stats.py` |
| US-04 | CORE-33, CORE-34, FE-06, FE-09 | AC-CORE-11, AC-FE-3 | `core/tests/test_core_acs.py`, `frontend/e2e/*.spec.ts` |
| US-05 | BE-07, BE-09, FE-08, FE-10 | AC-FE-8 | `backend/tests/unit/test_admin.py` (listing), `backend/tests/unit/test_chat_stats.py` (stats), `frontend/e2e/*.spec.ts` |
| US-06 | CORE-22, BE-12, FE-12 | AC-CORE-8, AC-BE-5, AC-BE-6, AC-FE-5, AC-FE-6 | `core/tests/test_core_acs.py`, `backend/tests/unit/test_admin.py`, `frontend/**` |
| US-07 | FE-05…07, BE-15 | AC-FE-3, AC-FE-4 | `backend/tests/unit/test_admin.py` (rate limit), `frontend/e2e/*.spec.ts` |
| US-08 | EVAL-01…08, FE-13 | AC-EVAL-1…4 | `eval/tests/test_eval.py`, `backend/tests/unit/test_eval_runner.py`, `backend/tests/unit/test_scan.py` (AC-EVAL-3) |
| US-09 | CORE-25 | AC-CORE-9 | `core/tests/test_core_acs.py` |

Other backend ACs: AC-BE-4/9/12 in `backend/tests/unit/test_scan.py` and the integration suite, AC-BE-7/10 in `backend/tests/unit/test_admin.py`, AC-BE-11 in `backend/tests/load/scan.k6.js` (k6, run before prod release), and AC-BE-13 in the `ci.yml` synth step (cdk-nag with justified suppressions in `backend/infra/bin/pif.ts`).
