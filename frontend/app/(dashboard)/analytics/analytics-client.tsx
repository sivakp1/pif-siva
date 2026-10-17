"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ACTION_COLORS } from "@/components/action-badge";
import { ApiErrorMessage, toDisplayError, type DisplayError } from "@/components/api-error";
import { ChartCard } from "@/components/chart-card";
import { useApps } from "@/components/use-apps";
import { Card, CardContent } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { apiFetch } from "@/lib/api-client";
import { fmtMs, fmtPct } from "@/lib/format";
import type { StatsBucket, StatsResponse } from "@/lib/schemas";

const RANGES = {
  "24h": { label: "Last 24 hours", ms: 86_400_000, granularity: "hour" },
  "7d": { label: "Last 7 days", ms: 7 * 86_400_000, granularity: "day" },
  "30d": { label: "Last 30 days", ms: 30 * 86_400_000, granularity: "day" },
} as const;
type RangeKey = keyof typeof RANGES;

const rate = (num: number, den: number) => (den > 0 ? num / den : null);

function label(ts: string, granularity: "hour" | "day") {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return granularity === "hour"
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Row extends StatsBucket {
  label: string;
  block_rate: number | null;
  judge_rate: number | null;
}

export function AnalyticsClient() {
  const { apps } = useApps();
  const [app, setApp] = React.useState("");
  const [range, setRange] = React.useState<RangeKey>("24h");
  const [source, setSource] = React.useState<"api" | "playground">("api");
  const [data, setData] = React.useState<StatsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<DisplayError | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    const cfg = RANGES[range];
    const q = new URLSearchParams({ from: new Date(now - cfg.ms).toISOString(), to: new Date(now).toISOString(), granularity: cfg.granularity });
    if (app) q.set("app_id", app);
    if (source === "playground") q.set("origin", "playground");
    setLoading(true);
    apiFetch<StatsResponse>(`/api/stats?${q.toString()}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(toDisplayError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app, range, source]);

  const granularity = data?.granularity ?? RANGES[range].granularity;
  const rows: Row[] = React.useMemo(
    () =>
      (data?.buckets ?? []).map((b) => ({
        ...b,
        label: label(b.ts, granularity),
        block_rate: rate(b.block, b.total),
        judge_rate: rate(b.judge_calls, b.total),
      })),
    [data, granularity],
  );

  const totals = React.useMemo(() => {
    const sum = (k: "total" | "block" | "flag" | "degraded" | "judge_calls") => rows.reduce((acc, r) => acc + (r[k] ?? 0), 0);
    const t: Partial<Record<"total" | "block" | "flag" | "degraded" | "judge_calls" | "p95_ms", number | null>> = data?.totals ?? {};
    const total = t.total ?? sum("total");
    const p95 = t.p95_ms ?? (rows.length ? Math.max(...rows.map((r) => r.p95_ms ?? 0)) : null);
    return {
      total,
      block: rate(t.block ?? sum("block"), total),
      flag: rate(t.flag ?? sum("flag"), total),
      judge: rate(t.judge_calls ?? sum("judge_calls"), total),
      degraded: rate(t.degraded ?? sum("degraded"), total),
      p95: p95 || null,
    };
  }, [data, rows]);

  const categories = React.useMemo(() => {
    const c = data?.categories ?? [];
    const list = Array.isArray(c) ? c : Object.entries(c).map(([category, count]) => ({ category, count }));
    return [...list].sort((a, b) => b.count - a.count).slice(0, 10);
  }, [data]);

  const kpis: [string, string][] = [
    ["Total requests", totals.total.toLocaleString()],
    ["Block rate", fmtPct(totals.block)],
    ["Flag rate", fmtPct(totals.flag)],
    ["Judge escalation rate", fmtPct(totals.judge)],
    ["p95 latency", fmtMs(totals.p95)],
    ["Degraded rate", fmtPct(totals.degraded)],
  ];

  const axis = { fontSize: 11, fill: "#334155" };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <div className="space-y-1">
          <Label htmlFor="an-app">App</Label>
          <Select id="an-app" value={app} onChange={(e) => setApp(e.target.value)} className="w-64">
            <option value="">All apps</option>
            {apps?.map((a) => (
              <option key={a.app_id} value={a.app_id}>
                {a.name} ({a.app_id})
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="an-range">Time range</Label>
          <Select id="an-range" value={range} onChange={(e) => setRange(e.target.value as RangeKey)} className="w-48">
            {(Object.keys(RANGES) as RangeKey[]).map((k) => (
              <option key={k} value={k}>
                {RANGES[k].label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="an-source">Source</Label>
          <Select id="an-source" value={source} onChange={(e) => setSource(e.target.value as "api" | "playground")} className="w-56">
            <option value="api">API traffic</option>
            <option value="playground">Playground scans</option>
          </Select>
        </div>
        {loading ? <Spinner className="self-end pb-2" label="Loading analytics" /> : null}
      </div>

      <ApiErrorMessage error={error} title="Could not load analytics" />
      {!loading && !error && source === "api" && data && (data.totals?.total ?? data.buckets.reduce((n, b) => n + (b.total ?? 0), 0)) === 0 ? (
        <p className="rounded-md border bg-muted/40 p-3 text-sm">
          No API traffic in this period. Scans made in the Playground are counted separately.{" "}
          <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => setSource("playground")}>
            Show Playground scans
          </button>
        </p>
      ) : null}

      <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {kpis.map(([k, v]) => (
          <Card key={k}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{k}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{v}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Requests by action"
          description={`Stacked by ${granularity}`}
          rows={rows}
          columns={[
            { key: "t", header: "Period", render: (r) => r.label },
            { key: "allow", header: "Allow", render: (r) => r.allow },
            { key: "flag", header: "Flag", render: (r) => r.flag },
            { key: "sanitize", header: "Sanitize", render: (r) => r.sanitize },
            { key: "block", header: "Block", render: (r) => r.block },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={axis} />
              <YAxis tick={axis} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar dataKey="allow" name="ALLOW" stackId="a" fill={ACTION_COLORS.allow} />
              <Bar dataKey="flag" name="FLAG" stackId="a" fill={ACTION_COLORS.flag} />
              <Bar dataKey="sanitize" name="SANITIZE" stackId="a" fill={ACTION_COLORS.sanitize} />
              <Bar dataKey="block" name="BLOCK" stackId="a" fill={ACTION_COLORS.block} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Block rate over time"
          rows={rows}
          columns={[
            { key: "t", header: "Period", render: (r) => r.label },
            { key: "br", header: "Block rate", render: (r) => fmtPct(r.block_rate) },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={axis} />
              <YAxis tick={axis} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} domain={[0, "auto"]} />
              <Tooltip formatter={(v) => fmtPct(Number(v))} />
              <Line type="monotone" dataKey="block_rate" name="Block rate" stroke={ACTION_COLORS.block} strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Top finding categories"
          rows={categories}
          columns={[
            { key: "c", header: "Category", render: (r) => r.category },
            { key: "n", header: "Count", render: (r) => r.count },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={categories} layout="vertical" margin={{ left: 24 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" tick={axis} allowDecimals={false} />
              <YAxis type="category" dataKey="category" tick={axis} width={140} />
              <Tooltip />
              <Bar dataKey="count" name="Findings" fill="#334155" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Latency p50 / p95"
          rows={rows}
          columns={[
            { key: "t", header: "Period", render: (r) => r.label },
            { key: "p50", header: "p50", render: (r) => fmtMs(r.p50_ms) },
            { key: "p95", header: "p95", render: (r) => fmtMs(r.p95_ms) },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={axis} />
              <YAxis tick={axis} unit=" ms" />
              <Tooltip formatter={(v) => fmtMs(Number(v))} />
              <Legend />
              <Line type="monotone" dataKey="p50_ms" name="p50" stroke="#0f766e" strokeWidth={2} dot={false} connectNulls />
              <Line type="monotone" dataKey="p95_ms" name="p95" stroke="#7c3aed" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Judge escalation rate over time"
          rows={rows}
          columns={[
            { key: "t", header: "Period", render: (r) => r.label },
            { key: "jr", header: "Judge escalation rate", render: (r) => fmtPct(r.judge_rate) },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={axis} />
              <YAxis tick={axis} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} domain={[0, "auto"]} />
              <Tooltip formatter={(v) => fmtPct(Number(v))} />
              <Line type="monotone" dataKey="judge_rate" name="Judge escalation rate" stroke="#1d4ed8" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
