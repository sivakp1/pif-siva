import type { Metadata } from "next";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui/misc";
import { EvalRunListResponseSchema } from "@/lib/schemas";
import { serverGet } from "@/lib/server-api";
import { EvaluationClient } from "./evaluation-client";

export const metadata: Metadata = { title: "Evaluation" };

export default async function EvaluationPage() {
  const session = await auth();
  const res = await serverGet("/eval-runs", EvalRunListResponseSchema);
  return (
    <>
      <PageHeader title="Evaluation" description="Offline evaluation runs over versioned datasets. Evaluation data is public or synthetic." />
      <EvaluationClient isAdmin={session?.user.role === "admin"} initialRuns={res.ok ? res.data.runs : []} initialError={res.ok ? null : res.error} />
    </>
  );
}
