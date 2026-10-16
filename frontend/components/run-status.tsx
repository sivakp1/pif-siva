import { Badge } from "@/components/ui/badge";

const STYLES: Record<string, string> = {
  queued: "border-slate-500 bg-slate-100 text-slate-900",
  running: "border-blue-700 bg-blue-50 text-blue-900",
  succeeded: "border-green-700 bg-green-50 text-green-900",
  failed: "border-red-700 bg-red-50 text-red-900",
};
const GLYPH: Record<string, string> = { queued: "…", running: "↻", succeeded: "✓", failed: "✕" };

export function RunStatus({ status }: { status: string }) {
  return (
    <Badge className={STYLES[status] ?? STYLES.queued}>
      <span aria-hidden>{GLYPH[status] ?? "•"}</span> {status}
    </Badge>
  );
}

export const isActiveRun = (status: string) => status === "queued" || status === "running";

/** Headline metrics: prefer the full pipeline, otherwise the first configuration. */
export function headlineConfig(configs: string[], metrics: Record<string, unknown>): string | undefined {
  if (metrics["L1+L2+L3"]) return "L1+L2+L3";
  return configs.find((c) => metrics[c]) ?? Object.keys(metrics)[0];
}
