"use client";

import * as React from "react";
import Link from "next/link";
import { ApiErrorMessage, useErrorToast, type DisplayError } from "@/components/api-error";
import { RunStatus, headlineConfig, isActiveRun } from "@/components/run-status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { Alert, Spinner, TableScroll, td, th } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/api-client";
import { fmtDateTime, fmtPct, fmtScore } from "@/lib/format";
import { EVAL_CONFIGS, type EvalRun } from "@/lib/schemas";

export function EvaluationClient({
  isAdmin,
  initialRuns,
  initialError,
}: {
  isAdmin: boolean;
  initialRuns: EvalRun[];
  initialError: { status: number; code: string; message: string; request_id: string } | null;
}) {
  const [runs, setRuns] = React.useState<EvalRun[]>(initialRuns);
  const [error, setError] = React.useState<DisplayError | null>(
    initialError ? { status: initialError.status, code: initialError.code, message: initialError.message, requestId: initialError.request_id } : null,
  );
  const [newOpen, setNewOpen] = React.useState(false);
  const showError = useErrorToast();

  const reload = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ runs: EvalRun[] }>("/api/eval-runs");
      setRuns(res.runs);
      setError(null);
    } catch (e) {
      setError(showError(e, "Could not load runs"));
    }
  }, [showError]);

  // Live poll every 5 s while any run is queued or running.
  const anyActive = runs.some((r) => isActiveRun(r.status));
  React.useEffect(() => {
    if (!anyActive) return;
    const id = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(id);
  }, [anyActive, reload]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {anyActive ? "A run is in progress — refreshing every 5 s." : `${runs.length} run${runs.length === 1 ? "" : "s"}`}
        </p>
        {isAdmin ? <Button onClick={() => setNewOpen(true)}>New run</Button> : null}
      </div>
      <ApiErrorMessage error={error} title="Could not load runs" />
      <TableScroll label="Evaluation runs">
        <table className="w-full min-w-[900px] border-collapse">
          <thead>
            <tr>
              {["Run ID", "Dataset", "Configurations", "Status", "Created by", "Created", "Headline F1", "Headline FPR"].map((h) => (
                <th key={h} scope="col" className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const hc = headlineConfig(r.configs, r.metrics);
              const m = hc ? r.metrics[hc] : undefined;
              return (
                <tr key={r.run_id} data-testid="run-row">
                  <td className={td}>
                    <Link href={`/evaluation/${encodeURIComponent(r.run_id)}`} className="font-mono text-xs text-primary underline-offset-2 hover:underline">
                      {r.run_id}
                    </Link>
                  </td>
                  <td className={td}>{r.dataset_version}</td>
                  <td className={`${td} text-xs`}>
                    {r.configs.join(", ")}
                    {r.thresholds_sweep ? " · sweep" : ""}
                  </td>
                  <td className={td}>
                    <RunStatus status={r.status} />
                  </td>
                  <td className={`${td} break-all text-xs`}>{r.created_by ?? "—"}</td>
                  <td className={td}>
                    <time dateTime={r.created_at} suppressHydrationWarning>
                      {fmtDateTime(r.created_at)}
                    </time>
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {fmtScore(m?.f1, 3)}
                    {hc && m ? <span className="block text-[11px] text-muted-foreground">{hc}</span> : null}
                  </td>
                  <td className={`${td} tabular-nums`}>{fmtPct(m?.fpr)}</td>
                </tr>
              );
            })}
            {runs.length === 0 ? (
              <tr>
                <td colSpan={8} className={`${td} py-8 text-center text-muted-foreground`}>
                  No evaluation runs yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableScroll>
      {isAdmin ? (
        <NewRunDialog
          open={newOpen}
          onClose={() => setNewOpen(false)}
          onCreated={() => {
            setNewOpen(false);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

function NewRunDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [datasets, setDatasets] = React.useState<{ dataset_version: string; item_count?: number }[] | null>(null);
  const [dataset, setDataset] = React.useState("");
  const [configs, setConfigs] = React.useState<string[]>(["L1", "L1+L2", "L1+L2+L3"]);
  const [sweep, setSweep] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<DisplayError | null>(null);
  const showError = useErrorToast();
  const { toast } = useToast();

  React.useEffect(() => {
    if (!open || datasets) return;
    apiFetch<{ datasets: { dataset_version: string; item_count?: number }[] }>("/api/datasets")
      .then((d) => {
        setDatasets(d.datasets);
        if (d.datasets[0]) setDataset((cur) => cur || d.datasets[0]!.dataset_version);
      })
      .catch((e) => setError(showError(e, "Could not load datasets")));
  }, [open, datasets, showError]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dataset || !configs.length) return;
    setBusy(true);
    try {
      await apiFetch("/api/eval-runs", { method: "POST", json: { dataset_version: dataset, configs, thresholds_sweep: sweep } });
      toast({ tone: "success", title: "Evaluation run started" });
      onCreated();
    } catch (err) {
      setError(showError(err, "Could not start run"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title="New evaluation run">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="nr-dataset">Dataset version</Label>
          <Select id="nr-dataset" value={dataset} onChange={(e) => setDataset(e.target.value)} disabled={!datasets?.length}>
            {!datasets ? <option value="">Loading…</option> : null}
            {datasets && !datasets.length ? <option value="">No datasets</option> : null}
            {datasets?.map((d) => (
              <option key={d.dataset_version} value={d.dataset_version}>
                {d.dataset_version}
                {d.item_count ? ` (${d.item_count} items)` : ""}
              </option>
            ))}
          </Select>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Configurations</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {EVAL_CONFIGS.map((c) => (
              <label key={c} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={configs.includes(c)} onChange={() => setConfigs((xs) => (xs.includes(c) ? xs.filter((x) => x !== c) : [...xs, c]))} />
                <code>{c}</code>
              </label>
            ))}
          </div>
          {!configs.length ? (
            <p role="alert" className="mt-1 text-xs font-medium text-destructive">
              Select at least one configuration.
            </p>
          ) : null}
        </fieldset>
        <Switch checked={sweep} onCheckedChange={setSweep} label="Threshold sweep" />
        <ApiErrorMessage error={error} title="Request failed" />
        {configs.includes("L1+L2+L3") || configs.includes("bedrock_guardrails") ? (
          <Alert tone="info">Configurations with the judge or Bedrock Guardrails call Bedrock and incur cost.</Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !dataset || !configs.length}>
            {busy ? <Spinner label="Starting" /> : null}
            Start run
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
