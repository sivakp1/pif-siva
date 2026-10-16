"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  React.useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied to clipboard" : ""}
      </span>
    </Button>
  );
}
