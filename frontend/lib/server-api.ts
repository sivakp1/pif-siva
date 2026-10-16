import "server-only";
import { headers } from "next/headers";
import type { ZodTypeAny, z } from "zod";
import { BffError, callControlPlane, getCaller } from "@/lib/bff";

// For React Server Components that render initial data (FE-19). Same path as the BFF:
// session cookie → access token → control plane → Zod validation.

export type ServerResult<T> = { ok: true; data: T } | { ok: false; error: { status: number; code: string; message: string; request_id: string } };

export async function serverGet<S extends ZodTypeAny>(path: string, schema: S, query?: URLSearchParams): Promise<ServerResult<z.output<S>>> {
  try {
    const caller = await getCaller(await headers());
    const data = await callControlPlane({ caller, method: "GET", path, query, responseSchema: schema });
    return { ok: true, data };
  } catch (err) {
    if (err instanceof BffError) {
      return { ok: false, error: { status: err.status, code: err.code, message: err.message, request_id: err.requestId } };
    }
    return { ok: false, error: { status: 500, code: "INTERNAL", message: "Unexpected error", request_id: "" } };
  }
}
