import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PIF Dashboard", template: "%s · PIF" },
  description: "Prompt-Injection Firewall dashboard",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request headers opts every page into dynamic rendering, which the per-request
  // CSP nonce (middleware.ts) requires. Next applies the nonce to its own scripts.
  await headers();
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
          Skip to content
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
