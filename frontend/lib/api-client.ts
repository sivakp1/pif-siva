// Browser-side helper for the same-origin BFF (/api/*). It never talks to the PIF API directly.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string,
    public retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.ceil(secs));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}

export async function apiFetch<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Network error — check your connection and try again", "", null);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; request_id?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "INTERNAL",
      err?.message ?? `Request failed (HTTP ${res.status})`,
      err?.request_id ?? "",
      parseRetryAfter(res.headers.get("Retry-After")),
    );
  }
  return body as T;
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
