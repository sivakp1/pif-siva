export function fmtScore(v: number | null | undefined, digits = 2): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  return typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "—";
}

export function fmtMs(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)} ms` : "—";
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(diff, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function totalLatency(l: number | { total: number } | undefined | null): number | null {
  if (typeof l === "number") return l;
  return l && typeof l.total === "number" ? l.total : null;
}
