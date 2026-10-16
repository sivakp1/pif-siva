import type { Metadata } from "next";
import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/misc";

export const metadata: Metadata = { title: "Sign in" };

/** Only same-origin relative paths are accepted as callbackUrl (no open redirects). */
function safeCallback(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || v.startsWith("/login")) return "/playground";
  return v;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const callbackUrl = safeCallback(sp.callbackUrl);
  const error = typeof sp.error === "string" ? sp.error : undefined;

  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">PIF</p>
          <CardTitle>
            <span className="text-xl">Prompt-Injection Firewall</span>
          </CardTitle>
          <CardDescription>Sign in with your organisation account to open the dashboard.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert tone="error" title="Sign-in failed">
              Please try again. If the problem continues, ask an administrator to check your account.
            </Alert>
          ) : null}
          <form
            action={async () => {
              "use server";
              await signIn("cognito", { redirectTo: callbackUrl });
            }}
          >
            <Button type="submit" className="w-full">
              Sign in with Cognito
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">You will be redirected to the Cognito Hosted UI.</p>
        </CardContent>
      </Card>
    </main>
  );
}
