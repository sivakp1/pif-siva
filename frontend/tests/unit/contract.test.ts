import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  AppListResponseSchema,
  CreateAppResponseSchema,
  CreateEvalRunResponseSchema,
  DatasetListResponseSchema,
  EvalRunDetailSchema,
  EvalRunListResponseSchema,
  PolicyResponseSchema,
  RotateKeyResponseSchema,
  ScanResultSchema,
  StatsResponseSchema,
  UpdateAppStatusResponseSchema,
  VerdictDetailSchema,
  VerdictListResponseSchema,
} from "@/lib/schemas";

// Fixtures are real admin-API responses captured by
// backend/tests/unit/test_contract_fixtures.py. Every BFF response schema must accept them.
const FIXTURES = join(__dirname, "..", "contract", "fixtures");

const CASES: [string, ZodTypeAny][] = [
  ["apps", AppListResponseSchema],
  ["create_app", CreateAppResponseSchema],
  ["rotate_key", RotateKeyResponseSchema],
  ["update_app", UpdateAppStatusResponseSchema],
  ["policy", PolicyResponseSchema],
  ["policy_put", PolicyResponseSchema],
  ["playground_scan", ScanResultSchema],
  ["verdicts", VerdictListResponseSchema],
  ["verdict_detail", VerdictDetailSchema],
  ["stats", StatsResponseSchema],
  ["datasets", DatasetListResponseSchema],
  ["create_eval_run", CreateEvalRunResponseSchema],
  ["eval_runs", EvalRunListResponseSchema],
  ["eval_run_detail", EvalRunDetailSchema],
];

describe("control-plane contract (backend responses vs BFF schemas)", () => {
  it.each(CASES)("%s matches its schema", (name, schema) => {
    const body = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
    const parsed = schema.safeParse(body);
    expect(parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 5), null, 2)).toBe("");
  });

  it("stats buckets carry timestamps and the playground sees layer skip reasons", () => {
    const stats = JSON.parse(readFileSync(join(FIXTURES, "stats.json"), "utf8"));
    expect(stats.buckets.length).toBeGreaterThan(0);
    expect(stats.buckets[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const scan = JSON.parse(readFileSync(join(FIXTURES, "playground_scan.json"), "utf8"));
    expect(scan.segments.some((s: { layers: { judge: { skipped_reason?: string } } }) => s.layers.judge.skipped_reason)).toBe(true);
  });
});
