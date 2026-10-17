import { NextResponse } from "next/server";
import { auth } from "@/auth";

// /chat and its API are public by design: anyone can chat, and every prompt is scanned by the firewall.
const PUBLIC_PATHS = ["/login", "/chat", "/api/public/chat"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname) || pathname.startsWith("/api/auth/");
}

function buildCsp(nonce: string): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets Next's nonce'd bootstrap load its own chunks; 'unsafe-eval' only for next dev.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // React and Recharts emit style attributes; scripts remain nonce-locked.
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function applySecurityHeaders(res: NextResponse, csp: string): NextResponse {
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.headers.set("X-Frame-Options", "DENY");
  return res;
}

/** Keep `/` readable in the query so the redirect is `/login?callbackUrl=/analytics` (AC-FE-1). */
function encodeCallback(path: string): string {
  return encodeURIComponent(path).replace(/%2F/gi, "/");
}

export default auth((req) => {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const { pathname, search } = req.nextUrl;
  // A session whose access token can no longer be refreshed counts as signed out.
  const signedIn = Boolean(req.auth) && !req.auth?.error;

  if (!signedIn && !isPublic(pathname)) {
    if (pathname.startsWith("/api/")) {
      const res = NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Sign in required", request_id: crypto.randomUUID() } },
        { status: 401 },
      );
      return applySecurityHeaders(res, csp);
    }
    const url = new URL(`/login?callbackUrl=${encodeCallback(pathname + search)}`, req.nextUrl.origin);
    return applySecurityHeaders(NextResponse.redirect(url), csp);
  }

  if (signedIn && pathname === "/login") {
    return applySecurityHeaders(NextResponse.redirect(new URL("/playground", req.nextUrl.origin)), csp);
  }

  // Next.js reads the nonce from the request CSP header and applies it to its own scripts.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  return applySecurityHeaders(res, csp);
});

export const config = {
  // Prefetches are deliberately NOT excluded: every page and API request passes the auth check.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
