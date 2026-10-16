"use client";

import * as React from "react";
import { ActionBadge } from "@/components/action-badge";
import { CopyButton } from "@/components/copy-button";
import { HighlightedText, PlainText } from "@/components/highlighted-text";
import { RiskBar, type Thresholds } from "@/components/risk-bar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, TableScroll, td, th } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { fmtMs, fmtScore } from "@/lib/format";
import { spansFor, type LayerCell, type ScanView } from "@/lib/scan-view";

function Missing({ cell }: { cell: LayerCell<unknown> }) {
  return (
    <Tooltip content={cell.skipped ?? "Layer did not run"}>
      <span aria-hidden>—</span>
      <span className="sr-only">Not run</span>
    </Tooltip>
  );
}

export function LayerTable({ view }: { view: ScanView }) {
  if (!view.segments.length) return <p className="text-sm text-muted-foreground">No per-segment details were returned.</p>;
  return (
    <TableScroll label="Per-segment layer results">
      <table className="w-full min-w-[820px] border-collapse">
        <caption className="sr-only">One row per segment with heuristic, classifier and judge results</caption>
        <thead>
          <tr>
            <th scope="col" className={th}>Segment</th>
            <th scope="col" className={th}>Heuristic score</th>
            <th scope="col" className={th}>Matched rules</th>
            <th scope="col" className={th}>Classifier score</th>
            <th scope="col" className={th}>Judge label</th>
            <th scope="col" className={th}>Judge confidence</th>
            <th scope="col" className={th}>Judge reason</th>
            <th scope="col" className={th}>Segment risk</th>
            <th scope="col" className={th}>Segment action</th>
          </tr>
        </thead>
        <tbody>
          {view.segments.map((s) => (
            <tr key={s.ref}>
              <th scope="row" className={`${td} text-left font-mono text-xs font-medium`}>
                {s.ref}
                {s.source ? <span className="block text-[11px] font-normal text-muted-foreground">{s.source}{s.trust ? ` · ${s.trust}` : ""}</span> : null}
              </th>
              <td className={`${td} tabular-nums`}>{s.heuristic.value ? fmtScore(s.heuristic.value.score) : <Missing cell={s.heuristic} />}</td>
              <td className={`${td} font-mono text-xs`}>
                {s.heuristic.value ? (s.heuristic.value.rules.length ? s.heuristic.value.rules.join(", ") : "none") : <Missing cell={s.heuristic} />}
              </td>
              <td className={`${td} tabular-nums`}>
                {s.classifier.value ? (
                  <>
                    {fmtScore(s.classifier.value.score)}
                    {s.classifier.value.chunks ? <span className="text-xs text-muted-foreground"> ({s.classifier.value.chunks} chunks)</span> : null}
                  </>
                ) : (
                  <Missing cell={s.classifier} />
                )}
              </td>
              <td className={td}>{s.judge.value ? s.judge.value.label : <Missing cell={s.judge} />}</td>
              <td className={`${td} tabular-nums`}>{s.judge.value ? fmtScore(s.judge.value.confidence) : <Missing cell={s.judge} />}</td>
              <td className={`${td} max-w-[22rem] whitespace-pre-wrap break-words`}>{s.judge.value ? s.judge.value.reason || "—" : <Missing cell={s.judge} />}</td>
              <td className={`${td} tabular-nums`}>{fmtScore(s.risk)}</td>
              <td className={td}>
                <ActionBadge action={s.action} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

const SEVERITY_CLS: Record<string, string> = {
  low: "border-slate-400 bg-slate-100 text-slate-900",
  medium: "border-amber-600 bg-amber-50 text-amber-950",
  high: "border-orange-700 bg-orange-50 text-orange-950",
  critical: "border-red-700 bg-red-50 text-red-900",
};

export function FindingsList({ view }: { view: ScanView }) {
  if (!view.findings.length) return <p className="text-sm text-muted-foreground">No findings.</p>;
  return (
    <ul className="space-y-2" aria-label="Findings">
      {view.findings.map((f, i) => (
        <li key={`${f.ref}-${f.category}-${i}`} className="rounded-md border p-3" data-testid="finding" data-category={f.category}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-slate-500 bg-white font-mono text-slate-900">{f.category}</Badge>
            <Badge className={SEVERITY_CLS[String(f.severity)] ?? SEVERITY_CLS.low}>severity: {String(f.severity)}</Badge>
            <span className="text-xs text-muted-foreground">
              layer: {f.layer} · <span className="font-mono">{f.ref}</span>
              {f.span ? ` · chars ${f.span.start}–${f.span.end}` : ""}
              {f.ref.includes("#") ? " (derived segment)" : ""}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{f.reason || "—"}</p>
        </li>
      ))}
    </ul>
  );
}

export function LatencyBreakdown({ latency }: { latency: ScanView["latency"] }) {
  if (!latency) return <p className="text-sm text-muted-foreground">No latency data.</p>;
  const rows: [string, number | null | undefined][] = [
    ["Total", latency.total],
    ["L1 heuristics", latency.l1],
    ["L2 classifier", latency.l2],
    ["L3 judge", latency.l3],
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {rows.map(([k, v]) => (
        <div key={k} className="rounded-md border p-2">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="text-lg font-semibold tabular-nums">{fmtMs(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RawJson({ value }: { value: unknown }) {
  const json = React.useMemo(() => JSON.stringify(value, null, 2), [value]);
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">Raw JSON</summary>
      <div className="border-t p-3">
        <div className="mb-2 flex justify-end">
          <CopyButton value={json} label="Copy JSON" />
        </div>
        <pre tabIndex={0} className="max-h-[480px] overflow-auto whitespace-pre rounded bg-slate-950 p-3 font-mono text-xs text-slate-50">
          {json}
        </pre>
      </div>
    </details>
  );
}

export interface OriginalTexts {
  input?: string;
  context_docs?: { content: string; content_type?: string }[];
}

export function ScanResultPanel({
  view,
  raw,
  thresholds,
  originals,
  extra,
}: {
  view: ScanView;
  raw: unknown;
  thresholds?: Thresholds | null;
  originals?: OriginalTexts;
  extra?: React.ReactNode;
}) {
  const docs = originals?.context_docs ?? [];
  return (
    <div className="space-y-4" data-testid="scan-result">
      <Card>
        <CardHeader>
          <CardTitle>Verdict</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">Action</span>
            <ActionBadge action={view.action} wouldAction={view.wouldAction} className="px-3 py-1 text-sm" />
            {view.degraded ? (
              <Badge className="border-amber-600 bg-amber-50 text-amber-950">
                <span aria-hidden>⚠</span> Degraded
              </Badge>
            ) : null}
          </div>
          <RiskBar risk={view.risk} thresholds={thresholds} />
          {extra}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Layers</CardTitle>
        </CardHeader>
        <CardContent>
          <LayerTable view={view} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Findings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <FindingsList view={view} />
          {originals?.input ? (
            <div>
              <h3 className="mb-1 text-sm font-medium">User input (highlighted spans)</h3>
              <HighlightedText text={originals.input} spans={spansFor(view.findings, "input")} />
            </div>
          ) : null}
          {docs.map((d, i) => (
            <div key={i}>
              <h3 className="mb-1 text-sm font-medium">Context document {i + 1} (highlighted spans)</h3>
              <HighlightedText text={d.content} spans={spansFor(view.findings, `context_docs[${i}]`)} />
            </div>
          ))}
          {originals ? <p className="text-xs text-muted-foreground">Span offsets refer to the normalized text, so highlights can shift slightly where whitespace was collapsed.</p> : null}
        </CardContent>
      </Card>

      {docs.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Sanitized output</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {docs.map((d, i) => {
              const sanitized = view.sanitized?.context_docs?.[i];
              return (
                <div key={i} className="grid gap-3 md:grid-cols-2" data-testid={`sanitized-doc-${i}`}>
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Document {i + 1} — original</h3>
                    <PlainText text={d.content} />
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Document {i + 1} — sanitized</h3>
                    {sanitized === undefined || sanitized === null ? (
                      <p className="rounded-md border p-3 text-sm text-muted-foreground">Not sanitized — the document is passed through unchanged.</p>
                    ) : (
                      <PlainText text={sanitized} className="bg-blue-50/50" />
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Latency</CardTitle>
        </CardHeader>
        <CardContent>
          <LatencyBreakdown latency={view.latency} />
        </CardContent>
      </Card>

      {view.action === "allow" && view.wouldAction && view.wouldAction !== "allow" ? (
        <Alert tone="info" title="Monitor mode">
          Nothing was blocked: this app is in monitor mode. The action that enforce mode would have taken is shown in brackets.
        </Alert>
      ) : null}

      <RawJson value={raw} />
    </div>
  );
}
