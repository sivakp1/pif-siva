"use client";

import * as React from "react";
import { ApiErrorMessage, toDisplayError, useErrorToast, type DisplayError } from "@/components/api-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { FieldError, Input, Label, Select } from "@/components/ui/input";
import { Alert, Spinner, TableScroll, td, th } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { TagInput } from "@/components/ui/tag-input";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/api-client";
import { fmtDateTime } from "@/lib/format";
import { DomainSchema, diffObjects, validatePolicy, type FieldErrors, type Policy } from "@/lib/policy";
import type { PolicyResponse } from "@/lib/schemas";

interface Draft {
  policy: Policy;
  allowed_link_domains: string[];
}

function toDraft(p: PolicyResponse, fallbackDomains: string[]): Draft {
  return { policy: structuredClone(p.policy), allowed_link_domains: [...(p.allowed_link_domains ?? fallbackDomains)] };
}

function errId(field: string) {
  return `pe-${field.replace(/\./g, "-")}-err`;
}

function UnitField({
  field,
  label,
  value,
  onChange,
  errors,
  disabled,
}: {
  field: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  errors: FieldErrors;
  disabled: boolean;
}) {
  const id = `pe-${field.replace(/\./g, "-")}`;
  const msgs = errors[field];
  const invalid = msgs?.length ? true : undefined;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={disabled}
          aria-label={`${label} slider`}
          aria-invalid={invalid}
          aria-describedby={invalid ? errId(field) : undefined}
          className="h-2 flex-1 accent-primary"
        />
        <Input
          id={id}
          type="number"
          min={0}
          max={1}
          step={0.01}
          inputMode="decimal"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={invalid ? errId(field) : undefined}
          className="w-24"
          data-testid={`input-${field}`}
        />
      </div>
      <FieldError id={errId(field)} messages={msgs} />
    </div>
  );
}

export function PolicyEditor({
  appId,
  isAdmin,
  initial,
  initialError,
  fallbackDomains,
}: {
  appId: string;
  isAdmin: boolean;
  initial: PolicyResponse | null;
  initialError: { status: number; code: string; message: string; request_id: string } | null;
  fallbackDomains: string[];
}) {
  const [base, setBase] = React.useState<PolicyResponse | null>(initial);
  const [draft, setDraft] = React.useState<Draft | null>(initial ? toDraft(initial, fallbackDomains) : null);
  const [loadError, setLoadError] = React.useState<DisplayError | null>(
    initialError ? { status: initialError.status, code: initialError.code, message: initialError.message, requestId: initialError.request_id } : null,
  );
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState<DisplayError | null>(null);
  const [saveError, setSaveError] = React.useState<DisplayError | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const showError = useErrorToast();
  const { toast } = useToast();
  const readOnly = !isAdmin;

  const reload = async () => {
    setReloading(true);
    try {
      const p = await apiFetch<PolicyResponse>(`/api/apps/${encodeURIComponent(appId)}/policy`);
      setBase(p);
      setDraft(toDraft(p, fallbackDomains));
      setConflict(null);
      setSaveError(null);
      setLoadError(null);
    } catch (e) {
      setLoadError(showError(e, "Could not load policy"));
    } finally {
      setReloading(false);
    }
  };

  const validation = React.useMemo(() => (draft ? validatePolicy(draft.policy) : null), [draft]);
  const errors: FieldErrors = validation && !validation.ok ? validation.errors : {};
  const baseDraft = React.useMemo(() => (base ? toDraft(base, fallbackDomains) : null), [base, fallbackDomains]);
  const diff = React.useMemo(() => (baseDraft && draft ? diffObjects(baseDraft, draft) : []), [baseDraft, draft]);
  const invalid = Boolean(validation && !validation.ok);

  if (!draft || !base) {
    return (
      <div className="space-y-3">
        <ApiErrorMessage error={loadError} title="Could not load policy" />
        <Button variant="outline" onClick={reload} disabled={reloading}>
          {reloading ? <Spinner label="Loading" /> : null}
          Retry
        </Button>
      </div>
    );
  }

  const set = (fn: (d: Draft) => void) =>
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      fn(next);
      return next;
    });

  const save = async () => {
    if (!validation?.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch<PolicyResponse>(`/api/apps/${encodeURIComponent(appId)}/policy`, {
        method: "PUT",
        json: { policy: validation.policy, policy_version: base.policy_version, allowed_link_domains: draft.allowed_link_domains },
      });
      setBase(res);
      setDraft(toDraft(res, draft.allowed_link_domains));
      setReviewOpen(false);
      toast({ tone: "success", title: `Policy saved (version ${res.policy_version})`, description: "It takes effect within 60 s." });
    } catch (e) {
      const err = toDisplayError(e);
      setReviewOpen(false);
      if (err.status === 409) {
        setConflict(err);
      } else {
        setSaveError(showError(e, "Could not save policy"));
      }
    } finally {
      setSaving(false);
    }
  };

  const p = draft.policy;
  const tagValidate = (v: string) => (v.length > 200 ? "Phrases must be ≤ 200 characters" : null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Policy version <strong>{base.policy_version}</strong>
          {base.updated_at ? ` · updated ${fmtDateTime(base.updated_at)}` : ""}
          {base.updated_by ? ` by ${base.updated_by}` : ""}
          {readOnly ? " · read-only (analyst)" : ""}
        </p>
        {isAdmin ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDraft(toDraft(base, fallbackDomains))} disabled={!diff.length || saving}>
              Discard changes
            </Button>
            <Button onClick={() => setReviewOpen(true)} disabled={invalid || !diff.length || saving} aria-describedby={invalid ? "pe-invalid-note" : undefined}>
              Save policy
            </Button>
          </div>
        ) : null}
      </div>

      {invalid ? (
        <p id="pe-invalid-note" className="text-sm font-medium text-destructive">
          Fix the errors below before saving.
        </p>
      ) : null}

      {conflict ? (
        <Alert tone="error" title="This policy was changed by someone else">
          <p>Your changes were not applied. Reload to get the latest version, then make your changes again.</p>
          {conflict.requestId ? <p className="mt-1 text-xs">Request ID: {conflict.requestId}</p> : null}
          <Button className="mt-2" variant="outline" size="sm" onClick={reload} disabled={reloading}>
            {reloading ? <Spinner label="Reloading" /> : null}
            Reload policy
          </Button>
        </Alert>
      ) : null}
      <ApiErrorMessage error={saveError} title="Could not save policy" />

      {p.mode === "monitor" ? (
        <Alert tone="info" title="Monitor mode">
          Nothing is blocked in this mode: every request is allowed, and results record the action that enforce mode would have taken (would_action).
        </Alert>
      ) : null}

      <fieldset disabled={readOnly} className="grid gap-4 lg:grid-cols-2">
        <legend className="sr-only">Policy fields</legend>
        <Card>
          <CardHeader>
            <CardTitle>Mode</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="pe-mode">Mode</Label>
              <Select id="pe-mode" value={p.mode} onChange={(e) => set((d) => void (d.policy.mode = e.target.value as Policy["mode"]))}>
                <option value="enforce">enforce</option>
                <option value="monitor">monitor</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pe-fail">Fail mode</Label>
              <Select id="pe-fail" value={p.fail_mode} onChange={(e) => set((d) => void (d.policy.fail_mode = e.target.value as Policy["fail_mode"]))}>
                <option value="open">open — allow with degraded=true if the pipeline fails</option>
                <option value="closed">closed — return 503 if the pipeline fails</option>
              </Select>
            </div>
            <Switch
              checked={p.block_on_context}
              onCheckedChange={(v) => set((d) => void (d.policy.block_on_context = v))}
              disabled={readOnly}
              label="Block whole request if a context document is ≥ block threshold"
            />
            <Switch checked={p.output_checks} onCheckedChange={(v) => set((d) => void (d.policy.output_checks = v))} disabled={readOnly} label="Output checks (proxy mode)" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Thresholds</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <UnitField field="thresholds.flag" label="Flag threshold" value={p.thresholds.flag} onChange={(v) => set((d) => void (d.policy.thresholds.flag = v))} errors={errors} disabled={readOnly} />
            <UnitField
              field="thresholds.sanitize"
              label="Sanitize threshold"
              value={p.thresholds.sanitize}
              onChange={(v) => set((d) => void (d.policy.thresholds.sanitize = v))}
              errors={errors}
              disabled={readOnly}
            />
            <UnitField field="thresholds.block" label="Block threshold" value={p.thresholds.block} onChange={(v) => set((d) => void (d.policy.thresholds.block = v))} errors={errors} disabled={readOnly} />
            <p className="text-xs text-muted-foreground">Must satisfy 0 &lt; flag ≤ sanitize ≤ block ≤ 1.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Judge</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Switch checked={p.judge_enabled} onCheckedChange={(v) => set((d) => void (d.policy.judge_enabled = v))} disabled={readOnly} label="Judge enabled" />
            <UnitField field="gray_zone.low" label="Gray zone low" value={p.gray_zone.low} onChange={(v) => set((d) => void (d.policy.gray_zone.low = v))} errors={errors} disabled={readOnly} />
            <UnitField field="gray_zone.high" label="Gray zone high" value={p.gray_zone.high} onChange={(v) => set((d) => void (d.policy.gray_zone.high = v))} errors={errors} disabled={readOnly} />
            <p className="text-xs text-muted-foreground">The judge runs only when the pre-score is in [low, high). Must satisfy 0 ≤ low &lt; high ≤ 1.</p>
            <div className="space-y-1">
              <Label htmlFor="pe-judge_budget">Judge budget (segments per request)</Label>
              <Input
                id="pe-judge_budget"
                type="number"
                min={0}
                max={20}
                step={1}
                value={Number.isFinite(p.judge_budget) ? p.judge_budget : ""}
                onChange={(e) => set((d) => void (d.policy.judge_budget = e.target.value === "" ? Number.NaN : Number(e.target.value)))}
                aria-invalid={errors.judge_budget ? true : undefined}
                aria-describedby={errors.judge_budget ? errId("judge_budget") : undefined}
                className="w-24"
              />
              <FieldError id={errId("judge_budget")} messages={errors.judge_budget} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Custom rules and links</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <TagInput
              id="pe-deny"
              label="Deny phrases"
              values={p.custom_rules.deny_phrases}
              onChange={(v) => set((d) => void (d.policy.custom_rules.deny_phrases = v))}
              disabled={readOnly}
              validate={tagValidate}
              placeholder="Type a phrase and press Enter"
            />
            <TagInput
              id="pe-allow"
              label="Allow phrases"
              values={p.custom_rules.allow_phrases}
              onChange={(v) => set((d) => void (d.policy.custom_rules.allow_phrases = v))}
              disabled={readOnly}
              validate={tagValidate}
              placeholder="Type a phrase and press Enter"
            />
            <TagInput
              id="pe-domains"
              label="Allowed link domains"
              values={draft.allowed_link_domains}
              onChange={(v) => set((d) => void (d.allowed_link_domains = v))}
              disabled={readOnly}
              validate={(v) => (DomainSchema.safeParse(v).success ? null : "Enter a domain such as example.com")}
              placeholder="example.com"
            />
          </CardContent>
        </Card>
      </fieldset>

      <Dialog
        open={reviewOpen}
        onClose={() => !saving && setReviewOpen(false)}
        title="Review changes"
        description={`Saving creates policy version ${base.policy_version + 1}. It is effective within 60 s.`}
        footer={
          <>
            <Button variant="outline" onClick={() => setReviewOpen(false)} disabled={saving}>
              Keep editing
            </Button>
            <Button onClick={save} disabled={saving || invalid}>
              {saving ? <Spinner label="Saving" /> : null}
              Confirm save
            </Button>
          </>
        }
      >
        <TableScroll label="Changed fields">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th scope="col" className={th}>Field</th>
                <th scope="col" className={th}>Current</th>
                <th scope="col" className={th}>New</th>
              </tr>
            </thead>
            <tbody>
              {diff.map((r) => (
                <tr key={r.field} data-testid="diff-row">
                  <th scope="row" className={`${td} text-left font-medium`}>
                    {r.label}
                  </th>
                  <td className={`${td} break-words text-red-800`}>
                    <span className="sr-only">Current: </span>
                    {r.before}
                  </td>
                  <td className={`${td} break-words text-green-800`}>
                    <span className="sr-only">New: </span>
                    {r.after}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Dialog>
    </div>
  );
}
