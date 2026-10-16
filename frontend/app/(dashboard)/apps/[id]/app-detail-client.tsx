"use client";

import { Tabs } from "@/components/ui/tabs";
import { fmtDateTime } from "@/lib/format";
import type { App, PolicyResponse } from "@/lib/schemas";
import { PolicyEditor } from "./policy-editor";

export function AppDetailClient({
  appId,
  app,
  isAdmin,
  initialPolicy,
  initialPolicyError,
}: {
  appId: string;
  app: App | null;
  isAdmin: boolean;
  initialPolicy: PolicyResponse | null;
  initialPolicyError: { status: number; code: string; message: string; request_id: string } | null;
}) {
  const overview = (
    <dl className="grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">App ID</dt>
      <dd className="font-mono">{appId}</dd>
      <dt className="text-muted-foreground">Name</dt>
      <dd>{app?.name ?? "—"}</dd>
      <dt className="text-muted-foreground">Status</dt>
      <dd>{app?.status ?? "—"}</dd>
      <dt className="text-muted-foreground">Key prefix</dt>
      <dd className="font-mono">{app?.key_prefix ? `${app.key_prefix}…` : "—"}</dd>
      <dt className="text-muted-foreground">Chat model</dt>
      <dd className="break-all font-mono text-xs">{app?.chat_model_id ?? "—"}</dd>
      <dt className="text-muted-foreground">Allowed link domains</dt>
      <dd>{app?.allowed_link_domains.length ? app.allowed_link_domains.join(", ") : "—"}</dd>
      <dt className="text-muted-foreground">Created</dt>
      <dd>{fmtDateTime(app?.created_at)}</dd>
      <dt className="text-muted-foreground">Last updated</dt>
      <dd>
        {fmtDateTime(app?.updated_at)}
        {app?.updated_by ? <span className="text-muted-foreground"> by {app.updated_by}</span> : null}
      </dd>
    </dl>
  );

  return (
    <Tabs
      label="App sections"
      initial="policy"
      tabs={[
        {
          id: "policy",
          label: "Policy",
          content: (
            <PolicyEditor
              appId={appId}
              isAdmin={isAdmin}
              initial={initialPolicy}
              initialError={initialPolicyError}
              fallbackDomains={app?.allowed_link_domains ?? []}
            />
          ),
        },
        { id: "overview", label: "Overview", content: overview },
      ]}
    />
  );
}
