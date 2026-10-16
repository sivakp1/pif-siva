import type { Finding, ScanResult, Segment, VerdictDetail } from "@/lib/schemas";

// View model shared by the playground result panel and the verdict detail page.

export interface LayerCell<T> {
  value: T | null;
  /** Why the layer did not run (tooltip for "—"). */
  skipped?: string;
}

export interface SegmentRow {
  ref: string;
  source?: string;
  trust?: string;
  risk: number;
  action: string;
  heuristic: LayerCell<{ score: number; rules: string[] }>;
  classifier: LayerCell<{ score: number; chunks?: number }>;
  judge: LayerCell<{ label: string; confidence: number | null; reason: string; category?: string | null }>;
}

export interface ScanView {
  action: string;
  wouldAction?: string | null;
  risk: number;
  degraded: boolean;
  segments: SegmentRow[];
  findings: Finding[];
  sanitized?: { input?: string | null; context_docs?: (string | null)[] } | null;
  latency?: { total: number; l1?: number | null; l2?: number | null; l3?: number | null } | null;
  versions?: Record<string, unknown>;
}

export interface LayerContext {
  degraded: boolean;
  judgeEnabled?: boolean;
  grayZone?: { low: number; high: number } | null;
}

const SKIP_REASONS: Record<string, string> = {
  not_in_gray_zone: "Not in gray zone — pre-score was clearly benign or clearly malicious",
  judge_disabled: "Judge disabled for this scan",
  disabled: "Layer disabled by policy",
  budget_exhausted: "Judge budget exhausted — higher-scoring segments were judged first",
  output_segment: "Judge is not run on LLM output (v1)",
  timeout: "Layer timed out — result is degraded",
  error: "Layer errored — result is degraded",
  not_requested: "Per-layer details were not requested (explain=false)",
};

export function describeSkip(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return SKIP_REASONS[code] ?? code.replace(/_/g, " ");
}

function judgeSkipReason(seg: { trust?: string; preScore: number | null }, ctx: LayerContext): string {
  if (ctx.judgeEnabled === false) return SKIP_REASONS.judge_disabled!;
  if (seg.trust === "output") return SKIP_REASONS.output_segment!;
  if (ctx.grayZone && seg.preScore !== null && (seg.preScore < ctx.grayZone.low || seg.preScore >= ctx.grayZone.high)) {
    return `Not in gray zone — pre-score ${seg.preScore.toFixed(2)} is outside [${ctx.grayZone.low.toFixed(2)}, ${ctx.grayZone.high.toFixed(2)})`;
  }
  if (ctx.judgeEnabled && ctx.grayZone) return SKIP_REASONS.budget_exhausted!;
  return "Judge did not run for this segment (not in gray zone, disabled or over budget)";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface FlatLayers {
  hScore: number | null;
  hRules: string[];
  hSkip?: string;
  cScore: number | null;
  cChunks?: number;
  cSkip?: string;
  jLabel: string | null;
  jConf: number | null;
  jReason: string;
  jCategory?: string | null;
  jSkip?: string;
}

function buildRow(base: { ref: string; source?: string; trust?: string; risk: number; action: string }, l: FlatLayers, ctx: LayerContext): SegmentRow {
  const preScore = l.hScore === null && l.cScore === null ? null : Math.max(l.hScore ?? 0, l.cScore ?? 0);
  return {
    ...base,
    heuristic:
      l.hScore !== null
        ? { value: { score: l.hScore, rules: l.hRules } }
        : { value: null, skipped: describeSkip(l.hSkip) ?? "Heuristic details not available for this segment" },
    classifier:
      l.cScore !== null
        ? { value: { score: l.cScore, chunks: l.cChunks } }
        : {
            value: null,
            skipped:
              describeSkip(l.cSkip) ??
              (ctx.degraded ? "Classifier unavailable (timed out or errored) — result is degraded" : "Classifier did not run for this segment"),
          },
    judge: l.jLabel
      ? { value: { label: l.jLabel, confidence: l.jConf, reason: l.jReason, category: l.jCategory } }
      : { value: null, skipped: describeSkip(l.jSkip) ?? judgeSkipReason({ trust: base.trust, preScore }, ctx) },
  };
}

export function segmentFromResult(s: Segment, ctx: LayerContext): SegmentRow {
  const h = s.layers?.heuristic;
  const c = s.layers?.classifier;
  const j = s.layers?.judge;
  return buildRow(
    { ref: s.ref, source: s.source, trust: s.trust, risk: s.risk, action: s.action },
    {
      hScore: num(h?.score),
      hRules: h?.rules ?? [],
      hSkip: h?.skipped_reason,
      cScore: num(c?.score),
      cChunks: c?.chunks,
      cSkip: c?.skipped_reason,
      jLabel: j?.label ?? null,
      jConf: num(j?.confidence),
      jReason: j?.reason ?? "",
      jCategory: j?.category,
      jSkip: j?.skipped_reason,
    },
    ctx,
  );
}

export function scanViewFromResult(r: ScanResult, ctx: Omit<LayerContext, "degraded">): ScanView {
  const full: LayerContext = { ...ctx, degraded: r.degraded };
  return {
    action: r.action,
    wouldAction: r.would_action,
    risk: r.risk_score,
    degraded: r.degraded,
    segments: r.segments.map((s) => segmentFromResult(s, full)),
    findings: r.findings,
    sanitized: r.sanitized ?? null,
    latency: r.latency_ms,
    versions: r.versions,
  };
}

export function scanViewFromVerdict(v: VerdictDetail): ScanView {
  const ctx: LayerContext = { degraded: v.degraded };
  const segments = v.segments_summary.map((s) => {
    const lh = s.layers?.heuristic;
    const lc = s.layers?.classifier;
    const lj = s.layers?.judge;
    return buildRow(
      { ref: s.ref, source: s.source, trust: s.trust, risk: s.risk, action: s.action },
      {
        hScore: num(lh?.score) ?? num(s.heuristic_score),
        hRules: lh?.rules ?? s.heuristic_rules ?? [],
        hSkip: lh?.skipped_reason,
        cScore: num(lc?.score) ?? num(s.classifier_score),
        cChunks: lc?.chunks,
        cSkip: lc?.skipped_reason,
        jLabel: lj?.label ?? s.judge_label ?? null,
        jConf: num(lj?.confidence) ?? num(s.judge_confidence),
        jReason: lj?.reason ?? s.judge_reason ?? "",
        jCategory: lj?.category,
        jSkip: lj?.skipped_reason,
      },
      ctx,
    );
  });
  const latency = typeof v.latency_ms === "object" && v.latency_ms ? v.latency_ms : null;
  return {
    action: v.action,
    wouldAction: v.would_action,
    risk: v.risk_score,
    degraded: v.degraded,
    segments,
    findings: v.findings,
    sanitized: null,
    latency,
    versions: v.versions,
  };
}

/** Findings whose spans can be shown on the given top-level ref (derived #hidden/#decoded refs cannot). */
export function spansFor(findings: Finding[], ref: string) {
  return findings
    .filter((f) => f.ref === ref && f.span && f.span.end > f.span.start)
    .map((f) => ({ start: f.span!.start, end: f.span!.end, label: f.category }));
}
