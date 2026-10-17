import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/misc";
import { AnalyticsClient } from "./analytics-client";

export const metadata: Metadata = { title: "Analytics" };

export default function AnalyticsPage() {
  return (
    <>
      <PageHeader title="Analytics" description="Aggregates from the stats table. API traffic and Playground scans are counted separately; choose one under Source." />
      <AnalyticsClient />
    </>
  );
}
