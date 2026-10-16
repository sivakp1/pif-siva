"use client";

import * as React from "react";
import Link from "next/link";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { ApiErrorMessage, useErrorToast, type DisplayError } from "@/components/api-error";
import { KeyRevealDialog } from "@/components/key-reveal-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Alert, Spinner, TableScroll, td, th } from "@/components/ui/misc";
import { TagInput } from "@/components/ui/tag-input";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/api-client";
import { fmtDateTime } from "@/lib/format";
import { DomainSchema } from "@/lib/policy";
import { CreateAppRequestSchema, type App } from "@/lib/schemas";

const col = createColumnHelper<App>();

function StatusBadge({ status }: { status: string }) {
  return status === "active" ? (
    <Badge className="border-green-700 bg-green-50 text-green-900">● active</Badge>
  ) : (
    <Badge className="border-slate-500 bg-slate-100 text-slate-800">○ {status}</Badge>
  );
}

type Pending = { kind: "rotate" | "disable" | "enable"; app: App } | null;

export function AppsClient({
  isAdmin,
  initialApps,
  initialError,
}: {
  isAdmin: boolean;
  initialApps: App[];
  initialError: { status: number; code: string; message: string; request_id: string } | null;
}) {
  const [apps, setApps] = React.useState<App[]>(initialApps);
  const [error, setError] = React.useState<DisplayError | null>(
    initialError ? { status: initialError.status, code: initialError.code, message: initialError.message, requestId: initialError.request_id } : null,
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [pending, setPending] = React.useState<Pending>(null);
  const [busy, setBusy] = React.useState(false);
  // One-time key display. Cleared on close (AC-FE-7).
  const [revealed, setRevealed] = React.useState<{ appId: string; key: string; note?: string } | null>(null);
  const showError = useErrorToast();
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ apps: App[] }>("/api/apps");
      setApps(res.apps);
      setError(null);
    } catch (e) {
      setError(showError(e, "Could not load apps"));
    }
  }, [showError]);

  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    const { kind, app } = pending;
    try {
      if (kind === "rotate") {
        const res = await apiFetch<{ api_key: string; prev_key_expires_at?: string }>(`/api/apps/${encodeURIComponent(app.app_id)}/rotate-key`, { method: "POST" });
        setPending(null);
        setRevealed({
          appId: app.app_id,
          key: res.api_key,
          note: res.prev_key_expires_at ? `The previous key stays valid until ${fmtDateTime(res.prev_key_expires_at)}.` : "The previous key stays valid for the grace period (24 h).",
        });
      } else {
        await apiFetch(`/api/apps/${encodeURIComponent(app.app_id)}`, { method: "PATCH", json: { status: kind === "disable" ? "disabled" : "active" } });
        setPending(null);
        toast({ tone: "success", title: kind === "disable" ? `Disabled ${app.app_id}` : `Enabled ${app.app_id}` });
      }
      await reload();
    } catch (e) {
      showError(e, "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const columns = React.useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack column value types differ per column
    const base: ColumnDef<App, any>[] = [
      col.accessor("app_id", {
        header: "App ID",
        cell: (c) => (
          <Link href={`/apps/${encodeURIComponent(c.getValue())}`} className="font-mono text-xs text-primary underline-offset-2 hover:underline">
            {c.getValue()}
          </Link>
        ),
      }),
      col.accessor("name", { header: "Name" }),
      col.accessor("status", { header: "Status", cell: (c) => <StatusBadge status={c.getValue()} /> }),
      col.accessor("key_prefix", { header: "Key prefix", cell: (c) => <code className="text-xs">{c.getValue() ? `${c.getValue()}…` : "—"}</code> }),
      col.accessor((a) => a.mode ?? a.policy?.mode, { id: "mode", header: "Mode", cell: (c) => c.getValue() ?? "—" }),
      col.accessor("policy_version", { header: "Policy version", cell: (c) => c.getValue() ?? "—" }),
      col.accessor("updated_at", {
        header: "Last updated",
        cell: (c) => (
          <time dateTime={c.getValue()} suppressHydrationWarning>
            {fmtDateTime(c.getValue())}
          </time>
        ),
      }),
    ];
    if (isAdmin) {
      base.push(
        col.display({
          id: "actions",
          header: "Actions",
          cell: (c) => {
            const app = c.row.original;
            return (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setPending({ kind: "rotate", app })} disabled={app.status !== "active"}>
                  Rotate key
                </Button>
                {app.status === "active" ? (
                  <Button size="sm" variant="destructive" onClick={() => setPending({ kind: "disable", app })}>
                    Disable app
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setPending({ kind: "enable", app })}>
                    Enable app
                  </Button>
                )}
              </div>
            );
          },
        }),
      );
    }
    return base;
  }, [isAdmin]);

  const table = useReactTable({ data: apps, columns, getCoreRowModel: getCoreRowModel(), getRowId: (a) => a.app_id });

  return (
    <div className="space-y-4">
      {isAdmin ? (
        <div className="flex justify-end">
          <Button onClick={() => setCreateOpen(true)}>Create app</Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">You have read-only access (analyst).</p>
      )}

      <ApiErrorMessage error={error} title="Could not load apps" />

      <TableScroll label="Apps table">
        <table className="w-full min-w-[900px] border-collapse">
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
              <tr key={row.id} data-testid="app-row">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={td}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {apps.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className={`${td} py-8 text-center text-muted-foreground`}>
                  No apps yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableScroll>

      {isAdmin ? (
        <CreateAppDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(app, key) => {
            setCreateOpen(false);
            setApps((xs) => [app, ...xs.filter((x) => x.app_id !== app.app_id)]);
            setRevealed({ appId: app.app_id, key });
          }}
        />
      ) : null}

      <Dialog
        open={pending !== null}
        onClose={() => !busy && setPending(null)}
        title={
          pending?.kind === "rotate" ? `Rotate key for ${pending.app.app_id}?` : pending?.kind === "disable" ? `Disable ${pending?.app.app_id}?` : `Enable ${pending?.app.app_id}?`
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant={pending?.kind === "disable" ? "destructive" : "default"} onClick={runPending} disabled={busy}>
              {busy ? <Spinner label="Working" /> : null}
              {pending?.kind === "rotate" ? "Rotate key" : pending?.kind === "disable" ? "Disable app" : "Enable app"}
            </Button>
          </>
        }
      >
        {pending?.kind === "rotate" ? (
          <p className="text-sm">
            A new API key will be generated and shown once. The current key keeps working for a <strong>24-hour grace period</strong>, then requests that use it
            are rejected with 401.
          </p>
        ) : pending?.kind === "disable" ? (
          <p className="text-sm">Requests with this app&apos;s key will be rejected until it is enabled again.</p>
        ) : (
          <p className="text-sm">The app&apos;s key will be accepted again.</p>
        )}
      </Dialog>

      <KeyRevealDialog apiKey={revealed?.key ?? null} appId={revealed?.appId ?? ""} note={revealed?.note} onClose={() => setRevealed(null)} />
    </div>
  );
}

type CreateErrors = Partial<Record<"app_id" | "name" | "chat_model_id" | "allowed_link_domains" | "_", string[]>>;

function CreateAppDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (app: App, key: string) => void }) {
  const [appId, setAppId] = React.useState("");
  const [name, setName] = React.useState("");
  const [model, setModel] = React.useState("");
  const [domains, setDomains] = React.useState<string[]>([]);
  const [errors, setErrors] = React.useState<CreateErrors>({});
  const [busy, setBusy] = React.useState(false);
  const [serverError, setServerError] = React.useState<DisplayError | null>(null);
  const showError = useErrorToast();

  const reset = () => {
    setAppId("");
    setName("");
    setModel("");
    setDomains([]);
    setErrors({});
    setServerError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = CreateAppRequestSchema.safeParse({ app_id: appId, name, chat_model_id: model, allowed_link_domains: domains });
    if (!parsed.success) {
      const errs: CreateErrors = {};
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0] ?? "_") as keyof CreateErrors;
        (errs[k] ??= []).push(issue.message);
      }
      setErrors(errs);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await apiFetch<{ app: App; api_key: string }>("/api/apps", { method: "POST", json: parsed.data });
      reset();
      onCreated(res.app, res.api_key);
    } catch (err) {
      setServerError(showError(err, "Could not create app"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) {
          reset();
          onClose();
        }
      }}
      title="Create app"
      description="The API key is generated by the server and shown once."
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="space-y-1">
          <Label htmlFor="ca-id">App ID</Label>
          <Input
            id="ca-id"
            value={appId}
            onChange={(e) => setAppId(e.target.value.toLowerCase())}
            placeholder="support-bot"
            aria-invalid={errors.app_id ? true : undefined}
            aria-describedby={errors.app_id ? "ca-id-err" : "ca-id-hint"}
            autoComplete="off"
          />
          <p id="ca-id-hint" className="text-xs text-muted-foreground">
            3–40 characters: a–z, 0–9 and -
          </p>
          <FieldError id="ca-id-err" messages={errors.app_id} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ca-name">Name</Label>
          <Input id="ca-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? "ca-name-err" : undefined} />
          <FieldError id="ca-name-err" messages={errors.name} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ca-model">Chat model ID (Bedrock)</Label>
          <Input
            id="ca-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. a Bedrock model or inference-profile ID"
            aria-invalid={errors.chat_model_id ? true : undefined}
            aria-describedby={errors.chat_model_id ? "ca-model-err" : undefined}
          />
          <FieldError id="ca-model-err" messages={errors.chat_model_id} />
        </div>
        <div>
          <TagInput
            id="ca-domains"
            label="Allowed link domains"
            values={domains}
            onChange={setDomains}
            placeholder="example.com, press Enter"
            validate={(v) => (DomainSchema.safeParse(v).success ? null : "Enter a domain such as example.com")}
          />
          <FieldError id="ca-domains-err" messages={errors.allowed_link_domains} />
        </div>
        <ApiErrorMessage error={serverError} title="Could not create app" />
        {Object.keys(errors).length ? <Alert tone="error">Fix the highlighted fields.</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner label="Creating" /> : null}
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
