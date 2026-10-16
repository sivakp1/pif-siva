"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { ActionBadge } from "@/components/action-badge";
import { ApiErrorMessage, useErrorToast, type DisplayError } from "@/components/api-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Spinner, TableScroll, td, th } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api-client";
import { fmtDateTime, fmtMs, fmtRelative, fmtScore, totalLatency } from "@/lib/format";
import type { VerdictListResponse, VerdictSummary } from "@/lib/schemas";
import { ACTIONS, ORIGINS, filtersToApiQuery, filtersToSearch, type Range, type VerdictFilters } from "@/lib/verdict-filters";

const col = createColumnHelper<VerdictSummary>();

const columns = [
  col.accessor("created_at", {
    header: "Time",
    cell: (c) => (
      <Link href={`/verdicts/${encodeURIComponent(c.row.original.verdict_id)}`} className="text-primary underline-offset-2 hover:underline">
        <time dateTime={c.getValue()} title={fmtRelative(c.getValue())} suppressHydrationWarning>
          {fmtDateTime(c.getValue())}
        </time>
      </Link>
    ),
  }),
  col.accessor("app_id", { header: "App", cell: (c) => <span className="font-mono text-xs">{c.getValue()}</span> }),
  col.accessor("action", { header: "Action", cell: (c) => <ActionBadge action={c.getValue()} wouldAction={c.row.original.would_action} /> }),
  col.accessor("risk_score", { header: "Risk", cell: (c) => <span className="tabular-nums">{fmtScore(c.getValue())}</span> }),
  col.accessor("categories", {
    header: "Categories",
    cell: (c) => (
      <span className="flex flex-wrap gap-1">
        {c.getValue().length ? c.getValue().map((cat) => <Badge key={cat} className="border-slate-400 bg-white font-mono text-[11px] text-slate-900">{cat}</Badge>) : <span className="text-muted-foreground">—</span>}
      </span>
    ),
  }),
  col.accessor("snippet", {
    header: "Snippet",
    cell: (c) => (
      <span className="block max-w-[22rem] truncate font-mono text-xs" title={c.getValue()}>
        {c.getValue().replace(/\s+/g, " ") || "—"}
      </span>
    ),
  }),
  col.accessor((r) => totalLatency(r.latency_ms ?? null), { id: "latency", header: "Latency", cell: (c) => <span className="tabular-nums">{fmtMs(c.getValue())}</span> }),
  col.accessor("degraded", {
    header: "Degraded",
    cell: (c) =>
      c.getValue() ? (
        <span title="Degraded: a layer timed out or errored">
          <span aria-hidden>⚠</span>
          <span className="sr-only">Degraded</span>
        </span>
      ) : (
        <span className="sr-only">Not degraded</span>
      ),
  }),
];

export function VerdictsClient({
  filters,
  initial,
  initialError,
  apps,
}: {
  filters: VerdictFilters;
  initial: VerdictListResponse;
  initialError: { status: number; code: string; message: string; request_id: string } | null;
  apps: { app_id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = React.useState<VerdictSummary[]>(initial.items);
  const [cursor, setCursor] = React.useState<string | null>(initial.next_cursor ?? null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [error, setError] = React.useState<DisplayError | null>(
    initialError ? { status: initialError.status, code: initialError.code, message: initialError.message, requestId: initialError.request_id } : null,
  );
  const [minRiskDraft, setMinRiskDraft] = React.useState(filters.minRisk === null ? "" : String(filters.minRisk));
  const anchorNow = React.useRef(Date.now());
  const showError = useErrorToast();

  // Controls reflect the pending selection immediately; the URL (and the server-rendered list) follows.
  const [form, setForm] = React.useState<VerdictFilters>(filters);
  // When the server re-renders for a new query, take its first page and resync the controls
  // (state adjustment during render, so a half-typed minimum risk is not wiped).
  const search = filtersToSearch(filters);
  const [renderedSearch, setRenderedSearch] = React.useState(search);
  if (search !== renderedSearch) {
    setRenderedSearch(search);
    setItems(initial.items);
    setCursor(initial.next_cursor ?? null);
    setError(initialError ? { status: initialError.status, code: initialError.code, message: initialError.message, requestId: initialError.request_id } : null);
    setForm(filters);
    if (filters.minRisk !== form.minRisk) setMinRiskDraft(filters.minRisk === null ? "" : String(filters.minRisk));
    anchorNow.current = Date.now();
  }
  const update = (patch: Partial<VerdictFilters>) => {
    const next = { ...form, ...patch };
    setForm(next);
    const qs = filtersToSearch(next);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const toggle = <T extends string>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const q = filtersToApiQuery(filters, anchorNow.current, cursor);
      const res = await apiFetch<VerdictListResponse>(`/api/verdicts?${q.toString()}`);
      setItems((xs) => {
        const seen = new Set(xs.map((x) => x.verdict_id));
        return [...xs, ...res.items.filter((x) => !seen.has(x.verdict_id))];
      });
      setCursor(res.next_cursor ?? null);
      setError(null);
    } catch (e) {
      setError(showError(e, "Could not load more verdicts"));
    } finally {
      setLoadingMore(false);
    }
  };

  // Optional auto-refresh every 10 s (off by default): prepend new verdicts.
  React.useEffect(() => {
    if (!autoRefresh) return;
    const tick = async () => {
      try {
        const res = await apiFetch<VerdictListResponse>(`/api/verdicts?${filtersToApiQuery(filters, Date.now()).toString()}`);
        setItems((xs) => {
          const seen = new Set(xs.map((x) => x.verdict_id));
          const fresh = res.items.filter((x) => !seen.has(x.verdict_id));
          return fresh.length ? [...fresh, ...xs] : xs;
        });
      } catch {
        // Keep showing the current list; the next tick retries.
      }
    };
    const id = window.setInterval(tick, 10_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, filters]);

  const table = useReactTable({ data: items, columns, getCoreRowModel: getCoreRowModel(), getRowId: (r) => r.verdict_id });

  return (
    <div className="space-y-4">
      <form className="grid gap-4 rounded-md border p-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Verdict filters" onSubmit={(e) => e.preventDefault()}>
        <div className="space-y-1">
          <Label htmlFor="f-app">App</Label>
          <Select id="f-app" value={form.app} onChange={(e) => update({ app: e.target.value })}>
            <option value="">All apps</option>
            {apps.map((a) => (
              <option key={a.app_id} value={a.app_id}>
                {a.name} ({a.app_id})
              </option>
            ))}
            {form.app && !apps.some((a) => a.app_id === form.app) ? <option value={form.app}>{form.app}</option> : null}
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="f-range">Time range</Label>
          <Select id="f-range" value={form.range} onChange={(e) => update({ range: e.target.value as Range })}>
            <option value="1h">Last 1 hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="custom">Custom…</option>
          </Select>
          {form.range === "custom" ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="f-from" className="text-xs">From</Label>
                <Input id="f-from" type="datetime-local" value={form.from} onChange={(e) => update({ from: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="f-to" className="text-xs">To</Label>
                <Input id="f-to" type="datetime-local" value={form.to} onChange={(e) => update({ to: e.target.value })} />
              </div>
            </div>
          ) : null}
        </div>

        <div className="space-y-1">
          <Label htmlFor="f-risk">Minimum risk (0–1)</Label>
          <Input
            id="f-risk"
            type="number"
            inputMode="decimal"
            min={0}
            max={1}
            step={0.05}
            value={minRiskDraft}
            onChange={(e) => setMinRiskDraft(e.target.value)}
            onBlur={() => {
              const v = minRiskDraft === "" ? null : Number(minRiskDraft);
              if (v === null || (Number.isFinite(v) && v >= 0 && v <= 1)) {
                if (v !== form.minRisk) update({ minRisk: v });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </div>

        <div className="space-y-3">
          <fieldset>
            <legend className="text-sm font-medium">Action</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {ACTIONS.map((a) => (
                <label key={a} className="inline-flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={form.actions.includes(a)} onChange={() => update({ actions: toggle(form.actions, a) })} />
                  {a.toUpperCase()}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-sm font-medium">Origin</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {ORIGINS.map((o) => (
                <label key={o} className="inline-flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={form.origins.includes(o)} onChange={() => update({ origins: toggle(form.origins, o) })} />
                  {o}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {items.length} verdict{items.length === 1 ? "" : "s"} shown
        </p>
        <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} label="Auto-refresh every 10 s" />
      </div>

      <ApiErrorMessage error={error} title="Could not load verdicts" />

      <TableScroll label="Verdicts table">
        <table className="w-full min-w-[960px] border-collapse">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} scope="col" className={th}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="hover:bg-muted/50" data-testid="verdict-row">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={td}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className={`${td} py-8 text-center text-muted-foreground`}>
                  No verdicts match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableScroll>

      {cursor ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Spinner label="Loading more" /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
