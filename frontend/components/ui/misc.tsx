import * as React from "react";
import { cn } from "@/lib/utils";

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2", className)}>
      <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

type AlertTone = "info" | "warning" | "error" | "success";
const tones: Record<AlertTone, string> = {
  info: "border-blue-300 bg-blue-50 text-blue-900",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  error: "border-red-300 bg-red-50 text-red-900",
  success: "border-green-300 bg-green-50 text-green-900",
};

export function Alert({
  tone = "info",
  title,
  children,
  className,
  role,
}: {
  tone?: AlertTone;
  title?: string;
  children?: React.ReactNode;
  className?: string;
  role?: "alert" | "status" | "note";
}) {
  return (
    <div role={role ?? (tone === "error" ? "alert" : "status")} className={cn("rounded-md border p-3 text-sm", tones[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
    </div>
  );
}

/** Tables scroll horizontally inside their container, never the page (FE-17). */
export function TableScroll({ children, className, label }: { children: React.ReactNode; className?: string; label?: string }) {
  return (
    <div className={cn("w-full overflow-x-auto rounded-md border", className)} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export const th = "whitespace-nowrap border-b bg-muted px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground";
export const td = "border-b px-3 py-2 align-top text-sm";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
