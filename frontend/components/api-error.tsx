"use client";

import * as React from "react";
import { Alert } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { isApiError } from "@/lib/api-client";

export interface DisplayError {
  status: number;
  code: string;
  message: string;
  requestId: string;
  retryAfterSeconds?: number | null;
}

export function toDisplayError(e: unknown): DisplayError {
  if (isApiError(e)) {
    return { status: e.status, code: e.code, message: e.message, requestId: e.requestId, retryAfterSeconds: e.retryAfterSeconds };
  }
  return { status: 0, code: "INTERNAL", message: "Something went wrong", requestId: "" };
}

/** FE-18: inline message that shows the request_id so it can be reported. */
export function ApiErrorMessage({ error, title, className }: { error: DisplayError | null; title?: string; className?: string }) {
  if (!error) return null;
  return (
    <Alert tone="error" title={title ?? "Request failed"} className={className}>
      <p>{error.message}</p>
      <p className="mt-1 text-xs">
        Code: <code>{error.code}</code>
        {error.requestId ? (
          <>
            {" "}
            · Request ID: <code className="select-all">{error.requestId}</code>
          </>
        ) : null}
      </p>
    </Alert>
  );
}

/** Returns a handler that converts an error, shows a toast and returns it for inline display. */
export function useErrorToast() {
  const { toast } = useToast();
  return React.useCallback(
    (e: unknown, title = "Request failed"): DisplayError => {
      const err = toDisplayError(e);
      toast({ tone: "error", title, description: err.requestId ? `${err.message} (request ${err.requestId})` : err.message });
      return err;
    },
    [toast],
  );
}
