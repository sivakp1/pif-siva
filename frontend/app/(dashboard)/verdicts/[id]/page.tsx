import * as React from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiErrorMessage } from "@/components/api-error";
import { PlainText } from "@/components/highlighted-text";
import { ScanResultPanel } from "@/components/scan-result-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, PageHeader } from "@/components/ui/misc";
import { fmtDateTime } from "@/lib/format";
import { scanViewFromVerdict } from "@/lib/scan-view";
import { PolicyResponseSchema, VerdictDetailSchema } from "@/lib/schemas";
import { serverGet } from "@/lib/server-api";

export const metadata: Metadata = { title: "Verdict" };

export default async function VerdictDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  const res = await serverGet(`/verdicts/${encodeURIComponent(id)}`, VerdictDetailSchema);
  if (!res.ok) {
    if (res.error.status === 404) notFound();
    return (
      <>
        <PageHeader title="Verdict" />
        <ApiErrorMessage
          error={{ status: res.error.status, code: res.error.code, message: res.error.message, requestId: res.error.request_id }}
          title="Could not load verdict"
        />
      </>
    );
  }
  const v = res.data;
  const policy = await serverGet(`/apps/${encodeURIComponent(v.app_id)}/policy`, PolicyResponseSchema);
  const view = scanViewFromVerdict(v);
  const versions: [string, unknown][] = [
    ["Core", v.versions.core],
    ["Rules", v.versions.rules],
    ["Classifier", v.versions.classifier],
    ["Judge", v.versions.judge],
    ["Policy", v.versions.policy],
  ];

  return (
    <>
      <PageHeader
        title="Verdict"
        description={`${v.verdict_id} · ${v.app_id} · ${fmtDateTime(v.created_at)}${v.origin ? ` · origin ${v.origin}` : ""}`}
        actions={
          <Link href="/verdicts" className="text-sm text-primary underline">
            Back to verdicts
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Input</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Alert tone="info">Full input is not retained by design (privacy policy P1).</Alert>
              <div>
                <h3 className="mb-1 text-sm font-medium">Snippet (redacted)</h3>
                <PlainText text={v.snippet || "—"} />
              </div>
              <div>
                <h3 className="mb-1 text-sm font-medium">input_hash</h3>
                <code className="block break-all rounded bg-muted p-2 text-xs">{v.input_hash ?? "—"}</code>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Versions</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {versions.map(([k, val]) => (
                  <React.Fragment key={k}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-all font-mono text-xs">{val === undefined || val === null ? "—" : String(val)}</dd>
                  </React.Fragment>
                ))}
              </dl>
              <Link href={`/apps/${encodeURIComponent(v.app_id)}`} className="mt-3 inline-block text-sm text-primary underline">
                View {v.app_id} policy
              </Link>
            </CardContent>
          </Card>
        </div>
        <ScanResultPanel view={view} raw={v} thresholds={policy.ok ? policy.data.policy.thresholds : null} />
      </div>
    </>
  );
}
