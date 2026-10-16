"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ApiErrorMessage, toDisplayError, type DisplayError } from "@/components/api-error";
import { ChartCard } from "@/components/chart-card";
import { PlainText } from "@/components/highlighted-text";
import { RunStatus, isActiveRun } from "@/components/run-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { Alert, Spinner, TableScroll, td, th } from "@/components/ui/misc";
import { apiFetch } from "@/lib/api-client";
import { fmtDateTime, fmtMs, fmtPct, fmtScore } from "@/lib/format";
import type { ConfigMetrics, EvalRunDetail, Misclassified } from "@/lib/schemas";

const SERIES_COLORS = ["#1d4ed8", "#b45309", "#047857", "#7c3aed", "#be123c"];

function ConfusionMatrix({ config, m }: { config: string; m: ConfigMetrics }) {
  const cell = (label: string, v: number | undefined, good: boolean) => (
    <td className={`border p-3 text-center ${good ? "bg-green-50" : "bg-red-50"}`}>
      <span className="block text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{v ?? "—"}</span>
    </td>
  );
  return (
    <div>
      <h3 className="mb-1 font-mono text-sm font-medium">{config}</h3>
      <table className="border-collapse text-sm">
        <caption className="sr-only">Confusion matrix for {config}</caption>
        <thead>
          <tr>
            <td />
            <th scope="col" className="border bg-muted px-3 py-1 text-xs">Predicted attack</th>
            <th scope="col" className="border bg-muted px-3 py-1 text-xs">Predicted benign</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="border bg-muted px-3 py-1 text-left text-xs">Actual attack</th>
            {cell("TP", m.tp, true)}
            {cell("FN", m.fn, false)}
          </tr>
          <tr>
            <th scope="row" className="border bg-muted px-3 py-1 text-left text-xs">Actual benign</th>
            {cell("FP", m.fp, false)}
            {cell("TN", m.tn, true)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function docText(d: Misclassified["context_docs"][number]): string {
  return typeof d === "string" ? d : d.content;
}

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function RunDetailClient({ runId }: { runId: string }) {
  const [run, setRun] = React.useState<EvalRunDetail | null>(null);
  const [error, setError] = React.useState<DisplayError | null>(null);
  const [kindFilter, setKindFilter] = React.useState<"all" | "fp" | "fn">("all");
  const [configFilter, setConfigFilter] = React.useState("all");

  const load = React.useCallback(async () => {
    try {
      const r = await apiFetch<EvalRunDetail>(`/api/eval-runs/${encodeURIComponent(runId)}`);
      setRun(r);
      setError(null);
    } catch (e) {
      setError(toDisplayError(e));
    }
  }, [runId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const active = run ? isActiveRun(run.status) : false;
  React.useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [active, load]);

  const configs = React.useMemo(() => (run ? run.configs.filter((c) => run.metrics[c]).concat(Object.keys(run.metrics).filter((c) => !run.configs.includes(c))) : []), [run]);

  const categoryRows = React.useMemo(() => {
    if (!run) return [];
    const cats = new Set<string>();
    for (const c of configs) Object.keys(run.metrics[c]?.per_category_recall ?? {}).forEach((k) => cats.add(k));
    return Array.from(cats)
      .sort()
      .map((category) => {
        const row: Record<string, string | number | null> = { category };
        for (const c of configs) row[c] = run.metrics[c]?.per_category_recall?.[category] ?? null;
        return row;
      });
  }, [run, configs]);

  const sweepConfigs = React.useMemo(() => Object.keys(run?.sweep ?? {}), [run]);
  const prRows = React.useMemo(() => {
    if (!run?.sweep) return [];
    const rows: { config: string; threshold: number; precision: number | null; recall: number | null; fpr: number | null }[] = [];
    for (const [config, pts] of Object.entries(run.sweep)) for (const p of pts) rows.push({ config, threshold: p.threshold, precision: p.precision, recall: p.recall, fpr: p.fpr ?? null });
    return rows;
  }, [run]);
  const defaultThreshold = run?.default_threshold ?? 0.5;

  if (!run) {
    return error ? (
      <ApiErrorMessage error={error} title="Could not load run" />
    ) : (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Spinner label="Loading run" /> Loading run…
      </div>
    );
  }

  const misclassified = (run.misclassified ?? []).filter((m) => (kindFilter === "all" || m.kind === kindFilter) && (configFilter === "all" || m.config === configFilter));
  const resultsHref = safeHref(run.results_url);

  return (
    <div className="space-y-6">
      <ApiErrorMessage error={error} title="Refresh failed" />
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
          <RunStatus status={run.status} />
          <span>
            Dataset <strong>{run.dataset_version}</strong>
          </span>
          <span>Configurations: {run.configs.join(", ")}</span>
          <span>Sweep: {run.thresholds_sweep ? "yes" : "no"}</span>
          <span>Created {fmtDateTime(run.created_at)}{run.created_by ? ` by ${run.created_by}` : ""}</span>
          {run.finished_at ? <span>Finished {fmtDateTime(run.finished_at)}</span> : null}
          {active ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground" aria-live="polite">
              <Spinner label="Run in progress" /> refreshing every 5 s
            </span>
          ) : null}
        </CardContent>
      </Card>

      {run.status === "failed" ? (
        <Alert tone="error" title="Run failed">
          <PlainText text={run.error ?? "No error message recorded."} />
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          {configs.length ? (
            <TableScroll label="Metrics per configuration">
              <table className="w-full min-w-[900px] border-collapse">
                <thead>
                  <tr>
                    {["Configuration", "Precision", "Recall", "F1", "FPR", "FPR (hard negatives)", "p50 latency", "p95 latency", "Judge escalation", "Cost / 1,000 req"].map((h) => (
                      <th key={h} scope="col" className={th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {configs.map((c) => {
                    const m = run.metrics[c]!;
                    return (
                      <tr key={c}>
                        <th scope="row" className={`${td} text-left font-mono text-xs`}>
                          {c}
                        </th>
                        <td className={`${td} tabular-nums`}>{fmtScore(m.precision, 3)}</td>
                        <td className={`${td} tabular-nums`}>{fmtScore(m.recall, 3)}</td>
                        <td className={`${td} tabular-nums font-semibold`}>{fmtScore(m.f1, 3)}</td>
                        <td className={`${td} tabular-nums`}>{fmtPct(m.fpr)}</td>
                        <td className={`${td} tabular-nums`}>{fmtPct(m.fpr_hard)}</td>
                        <td className={`${td} tabular-nums`}>{fmtMs(m.p50_ms)}</td>
                        <td className={`${td} tabular-nums`}>{fmtMs(m.p95_ms)}</td>
                        <td className={`${td} tabular-nums`}>{fmtPct(m.judge_escalation_rate)}</td>
                        <td className={`${td} tabular-nums`}>{typeof m.cost_per_1k === "number" ? `$${m.cost_per_1k.toFixed(4)}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          ) : (
            <p className="text-sm text-muted-foreground">{active ? "Metrics appear when the run finishes." : "No metrics recorded."}</p>
          )}
        </CardContent>
      </Card>

      {configs.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Confusion matrices</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-6">
            {configs.map((c) => (
              <ConfusionMatrix key={c} config={c} m={run.metrics[c]!} />
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Recall per attack category"
          description="Grouped by configuration"
          rows={categoryRows}
          columns={[
            { key: "category", header: "Category", render: (r) => String(r.category) },
            ...configs.map((c) => ({ key: c, header: c, render: (r: Record<string, string | number | null>) => fmtScore(r[c] as number | null, 3) })),
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={categoryRows}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="category" tick={{ fontSize: 11, fill: "#334155" }} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 11, fill: "#334155" }} />
              <Tooltip formatter={(v) => fmtScore(Number(v), 3)} />
              <Legend />
              {configs.map((c, i) => (
                <Bar key={c} dataKey={c} name={c} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Precision–recall curve"
          description={`Threshold sweep 0.05–0.95; the dot marks the current default threshold (${defaultThreshold.toFixed(2)}).`}
          rows={prRows}
          emptyText={run.thresholds_sweep ? "Sweep results are not available yet." : "This run did not include a threshold sweep."}
          columns={[
            { key: "config", header: "Configuration", render: (r) => r.config },
            { key: "t", header: "Threshold", render: (r) => `${r.threshold.toFixed(2)}${Math.abs(r.threshold - defaultThreshold) < 1e-9 ? " (default)" : ""}` },
            { key: "p", header: "Precision", render: (r) => fmtScore(r.precision, 3) },
            { key: "r", header: "Recall", render: (r) => fmtScore(r.recall, 3) },
            { key: "f", header: "FPR", render: (r) => fmtPct(r.fpr) },
          ]}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" dataKey="recall" name="Recall" domain={[0, 1]} tick={{ fontSize: 11, fill: "#334155" }} label={{ value: "Recall", position: "insideBottom", offset: -2, fontSize: 11 }} />
              <YAxis type="number" dataKey="precision" name="Precision" domain={[0, 1]} tick={{ fontSize: 11, fill: "#334155" }} />
              <Tooltip formatter={(v) => fmtScore(Number(v), 3)} />
              <Legend />
              {sweepConfigs.map((c, i) => {
                const pts = (run.sweep?.[c] ?? []).filter((p) => p.recall !== null && p.precision !== null).sort((a, b) => (a.recall ?? 0) - (b.recall ?? 0));
                const def = pts.find((p) => Math.abs(p.threshold - defaultThreshold) < 1e-9);
                const color = SERIES_COLORS[i % SERIES_COLORS.length];
                return (
                  <React.Fragment key={c}>
                    <Line data={pts} type="monotone" dataKey="precision" name={c} stroke={color} strokeWidth={2} dot={false} />
                    {def ? (
                      <ReferenceDot
                        x={def.recall ?? 0}
                        y={def.precision ?? 0}
                        r={6}
                        fill={color}
                        stroke="#0f172a"
                        label={i === 0 ? { value: `default t=${defaultThreshold.toFixed(2)}`, position: "bottom", fontSize: 10 } : undefined}
                      />
                    ) : null}
                  </React.Fragment>
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Misclassified items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <Label htmlFor="mc-kind">Type</Label>
              <Select id="mc-kind" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as "all" | "fp" | "fn")} className="w-48">
                <option value="all">All</option>
                <option value="fp">False positives</option>
                <option value="fn">False negatives</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="mc-config">Configuration</Label>
              <Select id="mc-config" value={configFilter} onChange={(e) => setConfigFilter(e.target.value)} className="w-48">
                <option value="all">All</option>
                {configs.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <TableScroll label="Misclassified items">
            <table className="w-full min-w-[900px] border-collapse">
              <thead>
                <tr>
                  {["Item", "Configuration", "Type", "Label", "Category", "Action", "Risk", "Text"].map((h) => (
                    <th key={h} scope="col" className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {misclassified.slice(0, 500).map((m, i) => (
                  <tr key={`${m.config}-${m.id}-${i}`}>
                    <td className={`${td} font-mono text-xs`}>{m.id}</td>
                    <td className={`${td} font-mono text-xs`}>{m.config}</td>
                    <td className={td}>{m.kind === "fp" ? "False positive" : m.kind === "fn" ? "False negative" : m.kind}</td>
                    <td className={td}>{m.label ?? "—"}</td>
                    <td className={td}>{m.category ?? "—"}</td>
                    <td className={td}>{m.action ? m.action.toUpperCase() : "—"}</td>
                    <td className={`${td} tabular-nums`}>{fmtScore(m.risk)}</td>
                    <td className={`${td} min-w-[24rem]`}>
                      {/* Full text is shown because evaluation data is public or synthetic; rendered as plain text (FE-14). */}
                      <PlainText text={m.input || "(no user input)"} scrollable />
                      {m.context_docs.map((d, j) => (
                        <PlainText key={j} text={docText(d)} scrollable className="mt-1 bg-amber-50/50" />
                      ))}
                    </td>
                  </tr>
                ))}
                {misclassified.length === 0 ? (
                  <tr>
                    <td colSpan={8} className={`${td} py-6 text-center text-muted-foreground`}>
                      {run.misclassified ? "No misclassified items for this filter." : "Misclassified items are not available yet."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableScroll>
          {misclassified.length > 500 ? <p className="text-xs text-muted-foreground">Showing the first 500 of {misclassified.length}. Download the predictions for the full list.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Downloads</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            <li>
              {resultsHref ? (
                <a href={resultsHref} className="text-primary underline" rel="noopener noreferrer" download>
                  results.json
                </a>
              ) : (
                <span className="text-muted-foreground">results.json — not available yet</span>
              )}
            </li>
            {Object.entries(run.predictions_urls ?? {}).map(([config, url]) => {
              const href = safeHref(url);
              return (
                <li key={config}>
                  {href ? (
                    <a href={href} className="text-primary underline" rel="noopener noreferrer" download>
                      predictions/{config}.jsonl
                    </a>
                  ) : (
                    <span>predictions/{config}.jsonl</span>
                  )}
                </li>
              );
            })}
            {!run.predictions_urls || !Object.keys(run.predictions_urls).length ? <li className="text-muted-foreground">Predictions JSONL — not available yet</li> : null}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">Links are short-lived presigned URLs; reload the page if one has expired.</p>
        </CardContent>
      </Card>
    </div>
  );
}
