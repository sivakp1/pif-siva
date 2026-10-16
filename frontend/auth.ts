import NextAuth from "next-auth";
import Cognito from "next-auth/providers/cognito";
import { decodeJwtPayload, refreshAccessToken, roleFromGroups } from "@/lib/cognito";

const EIGHT_HOURS = 8 * 60 * 60;
// Refresh the access token this many seconds before it expires.
const REFRESH_SKEW = 60;

export const { handlers, auth, signIn, signOut } = NextAuth({
  // AUTH_COGNITO_ID / AUTH_COGNITO_SECRET / AUTH_COGNITO_ISSUER are read automatically.
  providers: [
    Cognito({
      checks: ["pkce", "state", "nonce"],
      authorization: { params: { scope: "openid email profile" } },
    }),
  ],
  trustHost: true,
  pages: { signIn: "/login", error: "/login" },
  // FE-16: encrypted JWT session in an httpOnly, Secure (on https), SameSite=Lax cookie.
  // 8 h idle: the cookie's expiry slides forward on activity (updateAge) and lapses after 8 h idle.
  session: { strategy: "jwt", maxAge: EIGHT_HOURS, updateAge: 5 * 60 },
  jwt: { maxAge: EIGHT_HOURS },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        // Initial sign-in. Keep only what the BFF needs; the id token is not stored.
        const accessToken = account.access_token ?? "";
        const claims = decodeJwtPayload(accessToken);
        token.accessToken = accessToken;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at ?? Math.floor(Date.now() / 1000) + 3600;
        token.role = roleFromGroups(claims["cognito:groups"] ?? profile?.["cognito:groups"]);
        token.error = undefined;
        return token;
      }
      if (typeof token.expiresAt === "number" && Date.now() / 1000 < token.expiresAt - REFRESH_SKEW) {
        return token;
      }
      if (!token.refreshToken) {
        token.error = "RefreshTokenMissing";
        return token;
      }
      try {
        const next = await refreshAccessToken(token.refreshToken);
        token.accessToken = next.accessToken;
        token.expiresAt = next.expiresAt;
        if (next.refreshToken) token.refreshToken = next.refreshToken;
        token.role = next.role;
        token.error = undefined;
      } catch {
        token.error = "RefreshAccessTokenError";
      }
      return token;
    },
    async session({ session, token }) {
      // Only non-secret fields reach the browser. The access token stays in the encrypted cookie.
      session.user = {
        ...session.user,
        id: token.sub ?? "",
        role: token.role ?? null,
      };
      session.error = token.error;
      return session;
    },
  },
});
