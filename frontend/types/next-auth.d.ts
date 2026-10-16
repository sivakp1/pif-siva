import type { DefaultSession } from "next-auth";
import type { Role } from "@/lib/cognito";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role | null;
    } & DefaultSession["user"];
    error?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    role?: Role | null;
    error?: string;
  }
}
