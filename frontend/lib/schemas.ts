import { z } from "zod";
import { DomainSchema, PolicyBaseSchema, PolicySchema } from "@/lib/policy";

// Zod schemas for the control-plane API (backend.md B.2.2) as seen through the BFF.
// Request schemas are strict; response schemas are tolerant of extra fields (passthrough) so that
// additive backend changes do not break the dashboard.

export { PolicySchema, PolicyBaseSchema };

// ---------- Errors (BE-05) ----------
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional().default(""),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

// ---------- Common ----------
export const ActionSchema = z.enum(["allow", "flag", "sanitize", "block"]);
export type Action = z.infer<typeof ActionSchema>;
export const OriginSchema = z.enum(["api", "chat", "playground"]);
export type Origin = z.infer<typeof OriginSchema>;
export const SourceTypeSchema = z.enum(["web", "file", "email", "tool", "rag"]);
export const ContentTypeSchema = z.enum(["text", "html", "markdown"]);
export const AppIdSchema = z.string().regex(/^[a-z0-9-]{3,40}$/, "App ID must be 3–40 characters of a–z, 0–9 and -");

const nullableNumber = z.number().nullable().optional();

// ---------- ScanResult (A.10) ----------
export const LayerHeuristicSchema = z
  .object({ score: nullableNumber, rules: z.array(z.string()).optional().default([]), skipped_reason: z.string().optional() })
  .passthrough();
export const LayerClassifierSchema = z
  .object({ score: nullableNumber, chunks: z.number().optional(), skipped_reason: z.string().optional() })
  .passthrough();
export const LayerJudgeSchema = z
  .object({
    label: z.enum(["injection", "benign", "uncertain"]).nullable().optional(),
    confidence: nullableNumber,
    category: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    evidence: z.string().nullable().optional(),
    skipped_reason: z.string().optional(),
  })
  .passthrough();

export const SegmentSchema = z
  .object({
    ref: z.string(),
    source: z.string().optional(),
    trust: z.string().optional(),
    risk: z.number(),
    action: ActionSchema,
    layers: z
      .object({
        heuristic: LayerHeuristicSchema.nullable().optional(),
        classifier: LayerClassifierSchema.nullable().optional(),
        judge: LayerJudgeSchema.nullable().optional(),
      })
      .passthrough()
      .optional()
      .default({}),
  })
  .passthrough();
export type Segment = z.infer<typeof SegmentSchema>;

export const FindingSchema = z
  .object({
    ref: z.string(),
    category: z.string(),
    severity: z.enum(["low", "medium", "high", "critical"]).or(z.string()),
    layer: z.string(),
    span: z.object({ start: z.number().int(), end: z.number().int() }).nullable().optional(),
    reason: z.string().optional().default(""),
    rule_id: z.string().optional(),
  })
  .passthrough();
export type Finding = z.infer<typeof FindingSchema>;

export const LatencySchema = z
  .object({ total: z.number(), l1: nullableNumber, l2: nullableNumber, l3: nullableNumber })
  .passthrough();

export const VersionsSchema = z
  .object({
    core: z.string().optional(),
    rules: z.string().optional(),
    classifier: z.string().optional(),
    judge: z.string().optional(),
    policy: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

export const ScanResultSchema = z
  .object({
    verdict_id: z.string().optional(),
    request_id: z.string().optional(),
    action: ActionSchema,
    would_action: ActionSchema.nullable().optional(),
    risk_score: z.number(),
    degraded: z.boolean().optional().default(false),
    mode: z.enum(["enforce", "monitor"]).optional(),
    segments: z.array(SegmentSchema).optional().default([]),
    findings: z.array(FindingSchema).optional().default([]),
    sanitized: z
      .object({ input: z.string().nullable().optional(), context_docs: z.array(z.string().nullable()).optional() })
      .passthrough()
      .nullable()
      .optional(),
    latency_ms: LatencySchema,
    versions: VersionsSchema.optional().default({}),
  })
  .passthrough();
export type ScanResult = z.infer<typeof ScanResultSchema>;

// ---------- Playground ----------
export const PlaygroundDocSchema = z.object({
  id: z.string().max(64).optional(),
  content: z.string().max(32 * 1024, "Each context document must be ≤ 32 KB"),
  source_type: SourceTypeSchema,
  content_type: ContentTypeSchema,
});
export const PlaygroundScanRequestSchema = z
  .object({
    app_id: AppIdSchema,
    input: z.string().max(32 * 1024, "Input must be ≤ 32 KB").optional(),
    context_docs: z.array(PlaygroundDocSchema).max(20, "At most 20 context documents").optional().default([]),
    options: z
      .object({
        return_sanitized: z.boolean().default(true),
        explain: z.boolean().default(true),
        judge_enabled: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .refine((r) => Boolean(r.input?.length) || r.context_docs.length > 0, {
    message: "Provide user input or at least one context document",
    path: ["input"],
  });
export type PlaygroundScanRequest = z.input<typeof PlaygroundScanRequestSchema>;

// ---------- Verdicts ----------
export const VerdictSummarySchema = z
  .object({
    verdict_id: z.string(),
    app_id: z.string(),
    created_at: z.string(),
    action: ActionSchema,
    would_action: ActionSchema.nullable().optional(),
    risk_score: z.number(),
    categories: z.array(z.string()).optional().default([]),
    snippet: z.string().optional().default(""),
    latency_ms: z.union([z.number(), LatencySchema]).optional(),
    degraded: z.boolean().optional().default(false),
    origin: OriginSchema.or(z.string()).optional(),
    mode: z.string().optional(),
  })
  .passthrough();
export type VerdictSummary = z.infer<typeof VerdictSummarySchema>;

export const VerdictListResponseSchema = z
  .object({ items: z.array(VerdictSummarySchema), next_cursor: z.string().nullable().optional() })
  .passthrough();
export type VerdictListResponse = z.infer<typeof VerdictListResponseSchema>;

export const VerdictListQuerySchema = z
  .object({
    app_id: AppIdSchema.optional(),
    action: z
      .string()
      .regex(/^(allow|flag|sanitize|block)(,(allow|flag|sanitize|block))*$/)
      .optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    min_risk: z.coerce.number().min(0).max(1).optional(),
    origin: z
      .string()
      .regex(/^(api|chat|playground)(,(api|chat|playground))*$/)
      .optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/** Stored segment summary (BE-07): either A.10-shaped `layers` or flat fields. */
export const SegmentSummarySchema = z
  .object({
    ref: z.string(),
    source: z.string().optional(),
    trust: z.string().optional(),
    risk: z.number(),
    action: ActionSchema,
    layers: SegmentSchema.shape.layers,
    heuristic_score: nullableNumber,
    heuristic_rules: z.array(z.string()).optional(),
    classifier_score: nullableNumber,
    judge_label: z.string().nullable().optional(),
    judge_confidence: nullableNumber,
    judge_reason: z.string().nullable().optional(),
  })
  .passthrough();

export const VerdictDetailSchema = VerdictSummarySchema.extend({
  input_hash: z.string().optional(),
  segments_summary: z.array(SegmentSummarySchema).optional().default([]),
  findings: z.array(FindingSchema).optional().default([]),
  versions: VersionsSchema.optional().default({}),
  latency_ms: LatencySchema.optional(),
}).passthrough();
export type VerdictDetail = z.infer<typeof VerdictDetailSchema>;

// ---------- Stats ----------
export const StatsBucketSchema = z
  .object({
    ts: z.string(),
    total: z.number().default(0),
    allow: z.number().default(0),
    flag: z.number().default(0),
    sanitize: z.number().default(0),
    block: z.number().default(0),
    degraded: z.number().default(0),
    judge_calls: z.number().default(0),
    p50_ms: z.number().nullable().optional(),
    p95_ms: z.number().nullable().optional(),
  })
  .passthrough();
export type StatsBucket = z.infer<typeof StatsBucketSchema>;

export const StatsResponseSchema = z
  .object({
    granularity: z.enum(["hour", "day"]).optional(),
    buckets: z.array(StatsBucketSchema),
    categories: z
      .union([z.array(z.object({ category: z.string(), count: z.number() })), z.record(z.number())])
      .optional()
      .default([]),
    totals: StatsBucketSchema.omit({ ts: true }).partial().passthrough().optional(),
  })
  .passthrough();
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const StatsQuerySchema = z
  .object({
    app_id: AppIdSchema.optional(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    granularity: z.enum(["hour", "day"]).optional(),
    // Playground scans are counted in a separate partition (BE-09) and excluded unless asked for.
    origin: z.enum(["api", "playground"]).optional(),
  })
  .strict();

// ---------- Apps ----------
export const AppSchema = z
  .object({
    app_id: z.string(),
    name: z.string(),
    status: z.enum(["active", "disabled"]).or(z.string()),
    key_prefix: z.string().optional().default(""),
    mode: z.enum(["enforce", "monitor"]).optional(),
    policy: PolicyBaseSchema.partial().passthrough().optional(),
    policy_version: z.number().optional(),
    allowed_link_domains: z.array(z.string()).optional().default([]),
    chat_model_id: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    updated_by: z.string().optional(),
  })
  .passthrough();
export type App = z.infer<typeof AppSchema>;

export const AppListResponseSchema = z.object({ apps: z.array(AppSchema) }).passthrough();

export const CreateAppRequestSchema = z
  .object({
    app_id: AppIdSchema,
    name: z.string().trim().min(1, "Name is required").max(100),
    chat_model_id: z.string().trim().min(1, "Chat model is required").max(200),
    allowed_link_domains: z.array(DomainSchema).max(100).default([]),
  })
  .strict();
export type CreateAppRequest = z.input<typeof CreateAppRequestSchema>;

/** The API key is returned exactly once; the BFF passes it through and never logs or caches it. */
export const CreateAppResponseSchema = z
  .object({ app: AppSchema, api_key: z.string().min(1) })
  .passthrough();

export const RotateKeyResponseSchema = z
  .object({
    api_key: z.string().min(1),
    key_prefix: z.string().optional(),
    prev_key_expires_at: z.string().optional(),
  })
  .passthrough();

export const UpdateAppStatusRequestSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();
export const UpdateAppStatusResponseSchema = z.union([z.object({ app: AppSchema }).passthrough(), AppSchema]);

// ---------- Policy ----------
export const PolicyResponseSchema = z
  .object({
    app_id: z.string().optional(),
    policy: PolicyBaseSchema,
    policy_version: z.number(),
    allowed_link_domains: z.array(z.string()).optional(),
    updated_at: z.string().optional(),
    updated_by: z.string().optional(),
  })
  .passthrough();
export type PolicyResponse = z.infer<typeof PolicyResponseSchema>;

export const PolicyUpdateRequestSchema = z
  .object({
    policy: PolicySchema,
    policy_version: z.number().int().min(0),
    allowed_link_domains: z.array(DomainSchema).max(100).optional(),
  })
  .strict();

// ---------- Evaluation ----------
export const EVAL_CONFIGS = ["L1", "L1+L2", "L1+L2+L3", "bedrock_guardrails"] as const;
export const EvalConfigSchema = z.enum(EVAL_CONFIGS);

export const DatasetSchema = z
  .object({
    dataset_version: z.string(),
    item_count: z.number().optional(),
    created_at: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();
export const DatasetListResponseSchema = z.object({ datasets: z.array(DatasetSchema) }).passthrough();

export const ConfigMetricsSchema = z
  .object({
    tp: z.number().optional(),
    fp: z.number().optional(),
    tn: z.number().optional(),
    fn: z.number().optional(),
    precision: nullableNumber,
    recall: nullableNumber,
    f1: nullableNumber,
    fpr: nullableNumber,
    fpr_hard: nullableNumber,
    p50_ms: nullableNumber,
    p95_ms: nullableNumber,
    judge_escalation_rate: nullableNumber,
    cost_per_1k: nullableNumber,
    per_category_recall: z.record(z.number().nullable()).optional(),
  })
  .passthrough();
export type ConfigMetrics = z.infer<typeof ConfigMetricsSchema>;

export const SweepPointSchema = z
  .object({ threshold: z.number(), precision: z.number().nullable(), recall: z.number().nullable(), fpr: z.number().nullable().optional() })
  .passthrough();
export type SweepPoint = z.infer<typeof SweepPointSchema>;

export const MisclassifiedSchema = z
  .object({
    id: z.string(),
    config: z.string(),
    kind: z.enum(["fp", "fn"]).or(z.string()),
    label: z.string().optional(),
    category: z.string().optional(),
    action: z.string().optional(),
    risk: z.number().nullable().optional(),
    input: z.string().optional().default(""),
    context_docs: z
      .array(z.union([z.string(), z.object({ content: z.string() }).passthrough()]))
      .optional()
      .default([]),
  })
  .passthrough();
export type Misclassified = z.infer<typeof MisclassifiedSchema>;

export const EvalRunSchema = z
  .object({
    run_id: z.string(),
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    dataset_version: z.string(),
    configs: z.array(z.string()),
    thresholds_sweep: z.boolean().optional().default(false),
    metrics: z.record(ConfigMetricsSchema).optional().default({}),
    created_by: z.string().optional(),
    created_at: z.string().optional(),
    finished_at: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .passthrough();
export type EvalRun = z.infer<typeof EvalRunSchema>;

export const EvalRunListResponseSchema = z
  .object({ runs: z.array(EvalRunSchema), next_cursor: z.string().nullable().optional() })
  .passthrough();

export const EvalRunDetailSchema = EvalRunSchema.extend({
  default_threshold: z.number().optional(),
  sweep: z.record(z.array(SweepPointSchema)).optional(),
  misclassified: z.array(MisclassifiedSchema).optional(),
  results_url: z.string().url().nullable().optional(),
  predictions_urls: z.record(z.string().url()).optional(),
}).passthrough();
export type EvalRunDetail = z.infer<typeof EvalRunDetailSchema>;

/** results.json in S3 (fetched server-side by the BFF when the detail endpoint omits sweep/misclassified). */
export const ResultsJsonSchema = z
  .object({
    metrics: z.record(ConfigMetricsSchema).optional(),
    sweep: z.record(z.array(SweepPointSchema)).optional(),
    misclassified: z.array(MisclassifiedSchema).optional(),
    default_threshold: z.number().optional(),
  })
  .passthrough();

export const CreateEvalRunRequestSchema = z
  .object({
    dataset_version: z.string().min(1).max(64),
    configs: z.array(EvalConfigSchema).min(1, "Select at least one configuration"),
    thresholds_sweep: z.boolean().default(false),
  })
  .strict();
export const CreateEvalRunResponseSchema = z.union([
  z.object({ run: EvalRunSchema }).passthrough(),
  EvalRunSchema,
  z.object({ run_id: z.string(), status: z.string().optional() }).passthrough(),
]);
