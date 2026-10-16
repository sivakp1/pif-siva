import type { Metadata } from "next";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui/misc";
import { AppListResponseSchema } from "@/lib/schemas";
import { serverGet } from "@/lib/server-api";
import { AppsClient } from "./apps-client";

export const metadata: Metadata = { title: "Apps" };

export default async function AppsPage() {
  const session = await auth();
  const isAdmin = session?.user.role === "admin";
  const res = await serverGet("/apps", AppListResponseSchema);
  return (
    <>
      <PageHeader title="Apps" description="Applications protected by PIF, their keys and policies." />
      <AppsClient isAdmin={isAdmin} initialApps={res.ok ? res.data.apps : []} initialError={res.ok ? null : res.error} />
    </>
  );
}
