import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/misc";
import { serverGet } from "@/lib/server-api";
import { AppListResponseSchema, VerdictListResponseSchema } from "@/lib/schemas";
import { filtersToApiQuery, parseFilters } from "@/lib/verdict-filters";
import { VerdictsClient } from "./verdicts-client";

export const metadata: Metadata = { title: "Verdicts" };

// FE-19: the first page of verdicts is rendered on the server for a fast LCP.
export default async function VerdictsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseFilters(await searchParams);
  const [list, apps] = await Promise.all([
    serverGet("/verdicts", VerdictListResponseSchema, filtersToApiQuery(filters)),
    serverGet("/apps", AppListResponseSchema),
  ]);

  return (
    <>
      <PageHeader title="Verdicts" description="Recent firewall decisions. Snippets are PII-redacted; raw input is never stored." />
      <VerdictsClient
        filters={filters}
        initial={list.ok ? list.data : { items: [], next_cursor: null }}
        initialError={list.ok ? null : list.error}
        apps={apps.ok ? apps.data.apps.map((a) => ({ app_id: a.app_id, name: a.name })) : []}
      />
    </>
  );
}
