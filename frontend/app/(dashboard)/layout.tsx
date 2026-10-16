import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { MainNav } from "@/components/main-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Defence in depth: middleware already redirects unauthenticated users.
  const session = await auth();
  if (!session?.user || session.error) redirect("/login");
  const role = session.user.role;

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-semibold tracking-tight">PIF</span>
            <MainNav />
          </div>
          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="max-w-[12rem] truncate">{session.user.email ?? session.user.name ?? "Signed in"}</span>
              <Badge
                data-testid="role-badge"
                className={role === "admin" ? "border-purple-700 bg-purple-100 text-purple-900" : "border-slate-500 bg-slate-100 text-slate-900"}
              >
                {role ?? "no role"}
              </Badge>
              <span aria-hidden>▾</span>
              <span className="sr-only">User menu</span>
            </summary>
            <div className="absolute right-0 z-30 mt-1 w-56 rounded-md border bg-white p-2 shadow-lg">
              <p className="px-2 py-1 text-xs text-muted-foreground">
                Role: <strong>{role ?? "none"}</strong>
                {role === "analyst" ? " (read-only)" : ""}
              </p>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/login" });
                }}
              >
                <Button type="submit" variant="ghost" className="w-full justify-start">
                  Sign out
                </Button>
              </form>
            </div>
          </details>
        </div>
      </header>
      {role === null ? (
        <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-950">
          Your account is not in the <code>admin</code> or <code>analyst</code> group, so the API will refuse most requests.
        </div>
      ) : null}
      <main id="main" className="mx-auto max-w-7xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}
