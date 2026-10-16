import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/misc";
import { RunDetailClient } from "./run-detail-client";

export const metadata: Metadata = { title: "Evaluation run" };

// Data is loaded through /api/eval-runs/[runId], which also merges results.json from S3.
export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) notFound();
  return (
    <>
      <PageHeader
        title={`Run ${runId}`}
        actions={
          <Link href="/evaluation" className="text-sm text-primary underline">
            Back to runs
          </Link>
        }
      />
      <RunDetailClient runId={runId} />
    </>
  );
}
