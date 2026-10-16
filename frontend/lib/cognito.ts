// Cognito token helpers shared by auth.ts (edge + node) and the BFF.
// Never import this from a client component.

export type Role = "admin" | "analyst";

/** Decode a JWT payload without verifying it (the token came straight from Cognito over TLS). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Role from the `cognito:groups` claim. `admin` wins over `analyst`; no known group → null. */
export function roleFromGroups(groups: unknown): Role | null {
  const list = Array.isArray(groups) ? groups.map(String) : typeof groups === "string" ? [groups] : [];
  if (list.includes("admin")) return "admin";
  if (list.includes("analyst")) return "analyst";
  return null;
}

let tokenEndpointCache: { issuer: string; url: string } | null = null;

async function tokenEndpoint(): Promise<string> {
  const issuer = process.env.AUTH_COGNITO_ISSUER;
  if (!issuer) throw new Error("AUTH_COGNITO_ISSUER is not set");
  if (tokenEndpointCache?.issuer === issuer) return tokenEndpointCache.url;
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { cache: "no-store" });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as { token_endpoint?: string };
  if (!doc.token_endpoint) throw new Error("OIDC discovery has no token_endpoint");
  tokenEndpointCache = { issuer, url: doc.token_endpoint };
  return doc.token_endpoint;
}

export interface RefreshedTokens {
  accessToken: string;
  expiresAt: number; // epoch seconds
  refreshToken?: string;
  role: Role | null;
}

/** Exchange a Cognito refresh token for a new access token (refresh_token grant). */
export async function refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
  const clientId = process.env.AUTH_COGNITO_ID ?? "";
  const clientSecret = process.env.AUTH_COGNITO_SECRET ?? "";
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (clientSecret) headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  const res = await fetch(await tokenEndpoint(), { method: "POST", headers, body, cache: "no-store" });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  const claims = decodeJwtPayload(json.access_token);
  return {
    accessToken: json.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + Number(json.expires_in ?? 3600),
    refreshToken: json.refresh_token,
    role: roleFromGroups(claims["cognito:groups"]),
  };
}
