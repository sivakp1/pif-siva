import { z } from "zod";

// A.7 / CORE-22 policy schema. Shared by the BFF (request validation) and the policy editor
// (inline errors). Cross-field constraints name BOTH fields and attach the issue to both paths.

const unit = z.number({ invalid_type_error: "Must be a number" }).finite();

export const PolicyBaseSchema = z.object({
  mode: z.enum(["enforce", "monitor"]),
  fail_mode: z.enum(["open", "closed"]),
  thresholds: z.object({ flag: unit, sanitize: unit, block: unit }),
  gray_zone: z.object({ low: unit, high: unit }),
  judge_enabled: z.boolean(),
  judge_budget: z.number().int("Judge budget must be a whole number").min(0, "Judge budget must be ≥ 0").max(20, "Judge budget must be ≤ 20"),
  block_on_context: z.boolean(),
  output_checks: z.boolean(),
  custom_rules: z.object({
    deny_phrases: z.array(z.string().trim().min(1).max(200)).max(200),
    allow_phrases: z.array(z.string().trim().min(1).max(200)).max(200),
  }),
});

export const FIELD_LABELS: Record<string, string> = {
  "thresholds.flag": "Flag threshold",
  "thresholds.sanitize": "Sanitize threshold",
  "thresholds.block": "Block threshold",
  "gray_zone.low": "Gray zone low",
  "gray_zone.high": "Gray zone high",
  judge_budget: "Judge budget",
  mode: "Mode",
  fail_mode: "Fail mode",
  judge_enabled: "Judge enabled",
  block_on_context: "Block on context",
  output_checks: "Output checks",
  "custom_rules.deny_phrases": "Deny phrases",
  "custom_rules.allow_phrases": "Allow phrases",
  allowed_link_domains: "Allowed link domains",
};

export const PolicySchema = PolicyBaseSchema.superRefine((p, ctx) => {
  const both = (a: string[], b: string[], message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: a, message });
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: b, message });
  };
  const { flag, sanitize, block } = p.thresholds;
  if (!(flag > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["thresholds", "flag"], message: "Flag threshold must be > 0" });
  if (flag > sanitize) both(["thresholds", "flag"], ["thresholds", "sanitize"], "Flag threshold must be ≤ Sanitize threshold");
  if (sanitize > block) both(["thresholds", "sanitize"], ["thresholds", "block"], "Sanitize threshold must be ≤ Block threshold");
  if (block > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["thresholds", "block"], message: "Block threshold must be ≤ 1" });
  const { low, high } = p.gray_zone;
  if (low < 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gray_zone", "low"], message: "Gray zone low must be ≥ 0" });
  if (!(low < high)) both(["gray_zone", "low"], ["gray_zone", "high"], "Gray zone low must be < Gray zone high");
  if (high > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gray_zone", "high"], message: "Gray zone high must be ≤ 1" });
});

export type Policy = z.infer<typeof PolicyBaseSchema>;

export const DEFAULT_POLICY: Policy = {
  mode: "enforce",
  fail_mode: "open",
  thresholds: { flag: 0.5, sanitize: 0.7, block: 0.85 },
  gray_zone: { low: 0.3, high: 0.8 },
  judge_enabled: true,
  judge_budget: 3,
  block_on_context: false,
  output_checks: true,
  custom_rules: { deny_phrases: [], allow_phrases: [] },
};

export const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a domain such as example.com");

/** field path ("thresholds.flag") → list of messages (deduplicated). */
export type FieldErrors = Record<string, string[]>;

export function validatePolicy(policy: unknown): { ok: true; policy: Policy } | { ok: false; errors: FieldErrors } {
  const parsed = PolicySchema.safeParse(policy);
  if (parsed.success) return { ok: true, policy: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.join(".") || "_";
    const list = (errors[key] ??= []);
    if (!list.includes(issue.message)) list.push(issue.message);
  }
  return { ok: false, errors };
}

export interface DiffRow {
  field: string;
  label: string;
  before: string;
  after: string;
}

function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

function show(v: unknown): string {
  if (v === undefined) return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "(none)";
  return String(v);
}

/** Field-level diff used by the "Review changes" preview before saving. */
export function diffObjects(before: unknown, after: unknown): DiffRow[] {
  const a = flatten(before);
  const b = flatten(after);
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  return keys
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((k) => ({ field: k, label: FIELD_LABELS[k] ?? k, before: show(a[k]), after: show(b[k]) }));
}
