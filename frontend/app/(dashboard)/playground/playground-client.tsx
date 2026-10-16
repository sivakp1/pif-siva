"use client";

import * as React from "react";
import { ApiErrorMessage, toDisplayError, useErrorToast, type DisplayError } from "@/components/api-error";
import { ScanResultPanel, type OriginalTexts } from "@/components/scan-result-panel";
import { useApps } from "@/components/use-apps";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, Select, Textarea } from "@/components/ui/input";
import { Alert, Spinner } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api-client";
import { PRESETS, type PresetDoc } from "@/lib/presets";
import { scanViewFromResult } from "@/lib/scan-view";
import type { PolicyResponse, ScanResult } from "@/lib/schemas";

interface DocState extends PresetDoc {
  key: number;
}

const SOURCE_TYPES = ["web", "file", "email", "tool", "rag"] as const;
const CONTENT_TYPES = ["text", "html", "markdown"] as const;

export function PlaygroundClient() {
  const { apps, error: appsError } = useApps();
  const [appId, setAppId] = React.useState("");
  const [policy, setPolicy] = React.useState<PolicyResponse | null>(null);
  const [input, setInput] = React.useState("");
  const [docs, setDocs] = React.useState<DocState[]>([]);
  const [runJudge, setRunJudge] = React.useState(true);
  const [presetId, setPresetId] = React.useState("");
  const [scanning, setScanning] = React.useState(false);
  const [result, setResult] = React.useState<{ data: ScanResult; originals: OriginalTexts; judgeEnabled: boolean } | null>(null);
  const [error, setError] = React.useState<DisplayError | null>(null);
  const [retryIn, setRetryIn] = React.useState(0);
  const docKey = React.useRef(0);
  const presetRef = React.useRef<HTMLSelectElement>(null);
  const showError = useErrorToast();

  // Default to the first active app.
  React.useEffect(() => {
    if (!appId && apps?.length) {
      const first = apps.find((a) => a.status === "active") ?? apps[0];
      if (first) setAppId(first.app_id);
    }
  }, [apps, appId]);

  // Load the selected app's policy for thresholds, gray zone and the judge default.
  React.useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    apiFetch<PolicyResponse>(`/api/apps/${encodeURIComponent(appId)}/policy`)
      .then((p) => {
        if (cancelled) return;
        setPolicy(p);
        setRunJudge(p.policy.judge_enabled);
      })
      .catch(() => {
        if (!cancelled) setPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  // 429 countdown.
  React.useEffect(() => {
    if (retryIn <= 0) return;
    const t = window.setTimeout(() => setRetryIn((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [retryIn]);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setInput(p.input);
    setDocs(p.context_docs.map((d) => ({ ...d, key: ++docKey.current })));
    setResult(null);
    setError(null);
  };

  const addDoc = () => setDocs((ds) => [...ds, { key: ++docKey.current, content: "", source_type: "web", content_type: "text" }]);
  const updateDoc = (key: number, patch: Partial<PresetDoc>) => setDocs((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const removeDoc = (key: number) => setDocs((ds) => ds.filter((d) => d.key !== key));

  const canSubmit = Boolean(appId) && (input.trim().length > 0 || docs.some((d) => d.content.trim())) && !scanning && retryIn <= 0;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setScanning(true);
    setError(null);
    const sentDocs = docs.filter((d) => d.content.length > 0);
    const body = {
      app_id: appId,
      ...(input ? { input } : {}),
      context_docs: sentDocs.map((d, i) => ({ id: `doc-${i + 1}`, content: d.content, source_type: d.source_type, content_type: d.content_type })),
      options: { return_sanitized: true, explain: true, judge_enabled: runJudge },
    };
    try {
      const data = await apiFetch<ScanResult>("/api/playground/scan", { method: "POST", json: body });
      setResult({
        data,
        judgeEnabled: runJudge,
        originals: { input: input || undefined, context_docs: sentDocs.map((d) => ({ content: d.content, content_type: d.content_type })) },
      });
    } catch (err) {
      const de = toDisplayError(err);
      if (de.status === 429) {
        setRetryIn(de.retryAfterSeconds ?? 60);
        setError(de);
      } else {
        setError(showError(err, "Scan failed"));
      }
      setResult(null);
    } finally {
      setScanning(false);
    }
  };

  // The view reflects the options used for the scan that produced it, not the current toggles.
  const view = React.useMemo(
    () =>
      result
        ? scanViewFromResult(result.data, {
            judgeEnabled: result.judgeEnabled,
            grayZone: policy?.policy.gray_zone ?? null,
          })
        : null,
    [result, policy],
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Scan request</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4" aria-busy={scanning}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pg-app">App (policy)</Label>
                <Select id="pg-app" value={appId} onChange={(e) => setAppId(e.target.value)} disabled={!apps?.length}>
                  {!apps ? <option value="">Loading apps…</option> : null}
                  {apps && !apps.length ? <option value="">No apps available</option> : null}
                  {apps?.map((a) => (
                    <option key={a.app_id} value={a.app_id}>
                      {a.name} ({a.app_id}){a.status !== "active" ? " — disabled" : ""}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pg-preset">Presets</Label>
                <Select id="pg-preset" ref={presetRef} value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                  <option value="">Choose an example…</option>
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
                {presetId ? <p className="text-xs text-muted-foreground">{PRESETS.find((p) => p.id === presetId)?.description}</p> : null}
              </div>
            </div>
            <ApiErrorMessage error={appsError} title="Could not load apps" />

            <div className="space-y-1">
              <Label htmlFor="pg-input">User input</Label>
              <Textarea id="pg-input" value={input} onChange={(e) => setInput(e.target.value)} rows={4} placeholder="Type the end-user message…" />
            </div>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Context documents</legend>
              {docs.length === 0 ? <p className="text-xs text-muted-foreground">No documents. Add web pages, emails, files or RAG chunks to scan them as untrusted content.</p> : null}
              {docs.map((d, i) => (
                <div key={d.key} className="space-y-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                      <Label htmlFor={`doc-src-${d.key}`}>Document {i + 1} source_type</Label>
                      <Select id={`doc-src-${d.key}`} value={d.source_type} onChange={(e) => updateDoc(d.key, { source_type: e.target.value as PresetDoc["source_type"] })} className="w-32">
                        {SOURCE_TYPES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`doc-ct-${d.key}`}>Document {i + 1} content_type</Label>
                      <Select id={`doc-ct-${d.key}`} value={d.content_type} onChange={(e) => updateDoc(d.key, { content_type: e.target.value as PresetDoc["content_type"] })} className="w-32">
                        {CONTENT_TYPES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => removeDoc(d.key)} className="ml-auto">
                      Remove document {i + 1}
                    </Button>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`doc-content-${d.key}`}>Document {i + 1} content</Label>
                    <Textarea id={`doc-content-${d.key}`} value={d.content} onChange={(e) => updateDoc(d.key, { content: e.target.value })} rows={5} />
                  </div>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addDoc} disabled={docs.length >= 20}>
                Add context document
              </Button>
            </fieldset>

            <Switch checked={runJudge} onCheckedChange={setRunJudge} label="Run judge (overrides judge_enabled for this scan only)" />

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={!canSubmit}>
                {scanning ? <Spinner label="Scanning" /> : null}
                {scanning ? "Scanning…" : "Scan"}
              </Button>
              {appId && policy ? (
                <span className="text-xs text-muted-foreground">
                  Policy v{policy.policy_version} · mode {policy.policy.mode}
                </span>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <section aria-label="Scan result" aria-live="polite">
        {error?.status === 429 ? (
          <Alert tone="warning" title="Rate limited">
            {retryIn > 0 ? `Rate limit reached — try again in ${retryIn} s` : "Rate limit reached — you can try again now."}
            {error.requestId ? <span className="mt-1 block text-xs">Request ID: {error.requestId}</span> : null}
          </Alert>
        ) : error?.status === 413 ? (
          <Alert tone="error" title="Request too large">
            <p>{error.message}</p>
            <p className="mt-1 text-xs">Limits: total request ≤ 64 KB, at most 20 context documents, each segment ≤ 32 KB.</p>
            {error.requestId ? <p className="mt-1 text-xs">Request ID: {error.requestId}</p> : null}
          </Alert>
        ) : (
          <ApiErrorMessage error={error} title="Scan failed" />
        )}

        {scanning ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner label="Scanning" /> Running the three layers…
          </div>
        ) : null}

        {!scanning && view && result ? (
          <ScanResultPanel view={view} raw={result.data} thresholds={policy?.policy.thresholds ?? null} originals={result.originals} />
        ) : null}

        {!scanning && !result && !error ? (
          <Card>
            <CardHeader>
              <CardTitle>How a scan works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  <strong>L1 heuristics</strong> — versioned regex rules for overrides, role hijacks, prompt extraction, exfiltration, hidden HTML and invisible
                  Unicode.
                </li>
                <li>
                  <strong>L2 classifier</strong> — an ONNX prompt-injection model scores every chunk of every segment.
                </li>
                <li>
                  <strong>L3 judge</strong> — an LLM judge reviews only gray-zone segments, within the per-request budget.
                </li>
              </ol>
              <p>
                Scores are fused into a risk score, and the policy maps it to ALLOW, FLAG, SANITIZE or BLOCK.{" "}
                <Button variant="link" className="h-auto p-0" onClick={() => presetRef.current?.focus()}>
                  Try one of the presets
                </Button>
                .
              </p>
            </CardContent>
          </Card>
        ) : null}
      </section>
    </div>
  );
}
