// /verdicts filters live in the URL query string (FE-08, AC-FE-8). This module converts between
// the page's query string, the filter object used by the UI and the BFF/backend query.

export const ACTIONS = ["allow", "flag", "sanitize", "block"] as const;
export const ORIGINS = ["api", "chat", "playground"] as const;
export const RANGES = ["1h", "24h", "7d", "custom"] as const;
export const DEFAULT_ORIGINS: Origin[] = ["api", "chat"]; // playground off by default

type Action = (typeof ACTIONS)[number];
type Origin = (typeof ORIGINS)[number];
export type Range = (typeof RANGES)[number];

export interface VerdictFilters {
  app: string; // "" = all apps
  actions: Action[]; // [] = all
  range: Range;
  from: string; // datetime-local value (custom range only)
  to: string;
  minRisk: number | null;
  origins: Origin[];
}

export const DEFAULT_FILTERS: VerdictFilters = {
  app: "",
  actions: [],
  range: "24h",
  from: "",
  to: "",
  minRisk: null,
  origins: DEFAULT_ORIGINS,
};

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function get(src: ParamSource, key: string): string | undefined {
  if (src instanceof URLSearchParams) return src.get(key) ?? undefined;
  const v = src[key];
  return Array.isArray(v) ? v[0] : v;
}

function list<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));
}

export function parseFilters(src: ParamSource): VerdictFilters {
  const range = get(src, "range");
  const minRisk = get(src, "min_risk");
  const origin = get(src, "origin");
  const risk = minRisk !== undefined && minRisk !== "" ? Number(minRisk) : NaN;
  const app = get(src, "app") ?? "";
  return {
    app: /^[a-z0-9-]{3,40}$/.test(app) ? app : "",
    actions: list(get(src, "action"), ACTIONS),
    range: (RANGES as readonly string[]).includes(range ?? "") ? (range as Range) : DEFAULT_FILTERS.range,
    from: get(src, "from") ?? "",
    to: get(src, "to") ?? "",
    minRisk: Number.isFinite(risk) && risk >= 0 && risk <= 1 ? risk : null,
    origins: origin === undefined ? DEFAULT_ORIGINS : list(origin, ORIGINS),
  };
}

/** Page query string (only non-default values, so URLs stay short and shareable). */
export function filtersToSearch(f: VerdictFilters): string {
  const p = new URLSearchParams();
  if (f.app) p.set("app", f.app);
  if (f.actions.length) p.set("action", f.actions.join(","));
  if (f.range !== DEFAULT_FILTERS.range) p.set("range", f.range);
  if (f.range === "custom") {
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
  }
  if (f.minRisk !== null) p.set("min_risk", String(f.minRisk));
  const sameOrigins = f.origins.length === DEFAULT_ORIGINS.length && DEFAULT_ORIGINS.every((o) => f.origins.includes(o));
  if (!sameOrigins) p.set("origin", f.origins.join(","));
  return p.toString();
}

const RANGE_MS: Record<Exclude<Range, "custom">, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const t = Date.parse(local);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Query for GET /api/verdicts (→ /v1/admin/verdicts). */
export function filtersToApiQuery(f: VerdictFilters, now = Date.now(), cursor?: string): URLSearchParams {
  const p = new URLSearchParams();
  if (f.app) p.set("app_id", f.app);
  if (f.actions.length) p.set("action", f.actions.join(","));
  if (f.range === "custom") {
    const from = toIso(f.from);
    const to = toIso(f.to);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
  } else {
    p.set("from", new Date(now - RANGE_MS[f.range]).toISOString());
    p.set("to", new Date(now).toISOString());
  }
  if (f.minRisk !== null) p.set("min_risk", String(f.minRisk));
  // An empty origin selection means "all origins".
  p.set("origin", (f.origins.length ? f.origins : [...ORIGINS]).join(","));
  if (cursor) p.set("cursor", cursor);
  p.set("limit", "50");
  return p;
}
