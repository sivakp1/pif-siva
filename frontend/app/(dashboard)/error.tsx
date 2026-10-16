"use client";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/misc";

// FE-18: error boundary with a retry action. The digest lets support correlate server logs.
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-4 py-12">
      <Alert tone="error" title="Something went wrong">
        <p>The page could not be displayed.</p>
        {error.digest ? (
          <p className="mt-1 text-xs">
            Reference: <code className="select-all">{error.digest}</code>
          </p>
        ) : null}
      </Alert>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
