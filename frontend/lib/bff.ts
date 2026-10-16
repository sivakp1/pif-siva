import "server-only";
import { NextResponse } from "next/server";
import { getToken, type JWT } from "next-auth/jwt";
import type { ZodTypeAny, z } from "zod";
import { refreshAccessToken, type Role } from "@/lib/cognito";
import { ErrorEnvelopeSchema } from "@/lib/schemas";

// Backend-for-frontend core (FE-02). Every /api/* route handler goes through `proxy()`:
// session → role check → request validation → control-plane call with the Cognito access token
// → response validation → pass-through of the error envelope and Retry-After.

const UPSTREAM_TIMEOUT_MS = 30_000;
const SESSION_COOKIE = "authjs.session-token";

export interface Caller {
  accessToken: string;
  role: Role | null;
  sub: string;
}

export class BffError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string = crypto.randomUUID(),
    public retryAfter?: string | null,
  ) {
    super(message);
  }
}

function apiBase(): string {
  const base = process.env.PIF_API_BASE_URL;
  if (!base) throw new BffError(500, "INTERNAL", "PIF_API_BASE_URL is not configured");
  return base.replace(/\/+$/, "");
}

/** Reads the encrypted Auth.js JWT from the request cookies (handles the __Secure- prefix and chunking). */
export async function getCaller(headers: Headers): Promise<Caller> {
  const cookie = headers.get("cookie") ?? "";
  const secureCookie = cookie.includes(`__Secure-${SESSION_COOKIE}`);
  const cookieName = secureCookie ? `__Secure-${SESSION_COOKIE}` : SESSION_COOKIE;
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new BffError(500, "INTERNAL", "AUTH_SECRET is not configured");
  const token: JWT | null = await getToken({ req: { headers }, secret, secureCookie, cookieName, salt: cookieName });
  if (!token?.accessToken || token.error === "RefreshAccessTokenError") {
    throw new BffError(401, "UNAUTHORIZED", "Sign in required");
  }
  let { accessToken } = token;
  let role = token.role ?? null;
  // The middleware refreshes the cookie for the browser; this request still carries the old one,
  // so refresh in place if it is about to expire.
  if (typeof token.expiresAt === "number" && token.expiresAt - 30 < Date.now() / 1000) {
    if (!token.refreshToken) throw new BffError(401, "UNAUTHORIZED", "Session expired");
    try {
      const next = await refreshAccessToken(token.refreshToken);
      accessToken = next.accessToken;
      role = next.role;
    } catch {
      throw new BffError(401, "UNAUTHORIZED", "Session expired");
    }
  }
  return { accessToken, role, sub: token.sub ?? "" };
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof BffError) {
    const res = NextResponse.json(
      { error: { code: err.code, message: err.message, request_id: err.requestId } },
      { status: err.status, headers: { "Cache-Control": "no-store" } },
    );
    if (err.retryAfter) res.headers.set("Retry-After", err.retryAfter);
    return res;
  }
  // Never leak stack traces (BE-05 INTERNAL).
  const requestId = crypto.randomUUID();
  console.error(JSON.stringify({ msg: "bff_unexpected_error", request_id: requestId, error: String(err) }));
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Unexpected error", request_id: requestId } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

function codeForStatus(status: number): string {
  return (
    {
      400: "INVALID_REQUEST",
      401: "UNAUTHORIZED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      413: "PAYLOAD_TOO_LARGE",
      429: "RATE_LIMITED",
      503: "DETECTOR_UNAVAILABLE",
    } as Record<number, string>
  )[status] ?? "INTERNAL";
}

function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export interface UpstreamCall<S extends ZodTypeAny> {
  caller: Caller;
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string; // under /v1/admin, e.g. "/apps"
  query?: URLSearchParams;
  body?: unknown;
  responseSchema: S;
}

/** Call the control plane and validate the response. Throws BffError on any failure. */
export async function callControlPlane<S extends ZodTypeAny>(call: UpstreamCall<S>): Promise<z.output<S>> {
  const qs = call.query && [...call.query.keys()].length ? `?${call.query.toString()}` : "";
  const url = `${apiBase()}/v1/admin${call.path}${qs}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${call.caller.accessToken}`,
        Accept: "application/json",
        ...(call.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new BffError(502, "UPSTREAM_UNAVAILABLE", "The PIF API could not be reached");
  }

  const upstreamRequestId = res.headers.get("x-request-id") ?? res.headers.get("apigw-requestid") ?? undefined;
  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!res.ok) {
    const env = ErrorEnvelopeSchema.safeParse(json);
    if (env.success) {
      throw new BffError(
        res.status,
        env.data.error.code,
        env.data.error.message,
        env.data.error.request_id || upstreamRequestId,
        res.headers.get("Retry-After"),
      );
    }
    throw new BffError(
      res.status,
      codeForStatus(res.status),
      `Upstream error (HTTP ${res.status})`,
      upstreamRequestId,
      res.headers.get("Retry-After"),
    );
  }

  const parsed = call.responseSchema.safeParse(json ?? {});
  if (!parsed.success) {
    console.error(
      JSON.stringify({ msg: "bff_invalid_upstream_response", path: call.path, request_id: upstreamRequestId, issue: describeZodError(parsed.error) }),
    );
    throw new BffError(502, "INVALID_UPSTREAM_RESPONSE", "The PIF API returned an unexpected response", upstreamRequestId);
  }
  return parsed.data;
}

export interface ProxyOptions<B extends ZodTypeAny, S extends ZodTypeAny> {
  req: Request;
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  query?: URLSearchParams;
  bodySchema?: B;
  responseSchema: S;
  /** Admin-only mutation: analysts get 403 here, before the backend is called (AC-FE-2). */
  requireAdmin?: boolean;
  successStatus?: number;
  /** Optional post-processing of the validated response (e.g. merging results.json). */
  transform?: (data: z.output<S>, caller: Caller) => Promise<unknown> | unknown;
}

function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = "";
  }
  if (!host || originHost !== host) throw new BffError(403, "FORBIDDEN", "Cross-origin request rejected");
}

export async function proxy<B extends ZodTypeAny, S extends ZodTypeAny>(opts: ProxyOptions<B, S>): Promise<NextResponse> {
  try {
    if (opts.method !== "GET") assertSameOrigin(opts.req);
    const caller = await getCaller(opts.req.headers);
    if (opts.requireAdmin && caller.role !== "admin") {
      throw new BffError(403, "FORBIDDEN", "This action requires the admin role");
    }

    let body: unknown = undefined;
    if (opts.bodySchema) {
      let raw: unknown;
      try {
        raw = await opts.req.json();
      } catch {
        throw new BffError(400, "INVALID_REQUEST", "Request body must be JSON");
      }
      const parsed = opts.bodySchema.safeParse(raw);
      if (!parsed.success) throw new BffError(400, "INVALID_REQUEST", describeZodError(parsed.error));
      body = parsed.data;
    }

    const data = await callControlPlane({
      caller,
      method: opts.method,
      path: opts.path,
      query: opts.query,
      body,
      responseSchema: opts.responseSchema,
    });
    const out = opts.transform ? await opts.transform(data, caller) : data;
    return NextResponse.json(out, { status: opts.successStatus ?? 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Validate URL query params against a schema and re-serialise them for the upstream call. */
export function validatedQuery(url: string, schema: ZodTypeAny): URLSearchParams {
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new BffError(400, "INVALID_REQUEST", describeZodError(parsed.error));
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(parsed.data as Record<string, unknown>)) {
    if (v !== undefined && v !== null && v !== "") out.set(k, String(v));
  }
  return out;
}

/** Path segment guard for dynamic route params. */
export function safeSegment(value: string, label = "id"): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new BffError(400, "INVALID_REQUEST", `${label} is invalid`);
  return encodeURIComponent(value);
}
