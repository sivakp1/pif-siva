import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { ApiErrorMessage } from "@/components/api-error";
import { PageHeader } from "@/components/ui/misc";
import { AppListResponseSchema, PolicyResponseSchema } from "@/lib/schemas";
import { serverGet } from "@/lib/server-api";
import { AppDetailClient } from "./app-detail-client";

export const metadata: Metadata = { title: "App" };

export default async function AppDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9-]{3,40}$/.test(id)) notFound();
  const session = await auth();
  const isAdmin = session?.user.role === "admin";
  const [apps, policy] = await Promise.all([
    serverGet("/apps", AppListResponseSchema),
    serverGet(`/apps/${encodeURIComponent(id)}/policy`, PolicyResponseSchema),
  ]);
  const app = apps.ok ? apps.data.apps.find((a) => a.app_id === id) : undefined;
  if (apps.ok && !app) notFound();

  return (
    <>
      <PageHeader
        title={app?.name ?? id}
        description={`App ID ${id}`}
        actions={
          <Link href="/apps" className="text-sm text-primary underline">
            Back to apps
          </Link>
        }
      />
      {!apps.ok ? (
        <ApiErrorMessage
          error={{ status: apps.error.status, code: apps.error.code, message: apps.error.message, requestId: apps.error.request_id }}
          title="Could not load app"
          className="mb-4"
        />
      ) : null}
      <AppDetailClient
        appId={id}
        app={app ?? null}
        isAdmin={isAdmin}
        initialPolicy={policy.ok ? policy.data : null}
        initialPolicyError={policy.ok ? null : policy.error}
      />
    </>
  );
}
