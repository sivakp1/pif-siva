import { errorResponse, proxy, safeSegment } from "@/lib/bff";
import { EvalRunDetailSchema, ResultsJsonSchema, type EvalRunDetail } from "@/lib/schemas";

export const dynamic = "force-dynamic";

const MAX_RESULTS_BYTES = 10 * 1024 * 1024;

/** Only presigned S3 URLs are fetched server-side (the browser's CSP allows connect-src 'self' only). */
function isS3Url(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname.endsWith(".amazonaws.com") || u.hostname === "amazonaws.com");
  } catch {
    return false;
  }
}

async function withResults(run: EvalRunDetail): Promise<EvalRunDetail> {
  const needsMore = !run.sweep || !run.misclassified;
  if (run.status !== "succeeded" || !needsMore || !run.results_url || !isS3Url(run.results_url)) return run;
  try {
    const res = await fetch(run.results_url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const len = Number(res.headers.get("content-length") ?? "0");
    if (!res.ok || len > MAX_RESULTS_BYTES) return run;
    const parsed = ResultsJsonSchema.safeParse(await res.json());
    if (!parsed.success) return run;
    return {
      ...run,
      metrics: Object.keys(run.metrics).length ? run.metrics : (parsed.data.metrics ?? {}),
      sweep: run.sweep ?? parsed.data.sweep,
      misclassified: run.misclassified ?? parsed.data.misclassified,
      default_threshold: run.default_threshold ?? parsed.data.default_threshold,
    };
  } catch {
    return run;
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    return proxy({
      req,
      method: "GET",
      path: `/eval-runs/${safeSegment(runId, "run_id")}`,
      responseSchema: EvalRunDetailSchema,
      transform: (run) => withResults(run),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
