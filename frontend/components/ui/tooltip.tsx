"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Keyboard-accessible tooltip: the trigger is focusable and the tip is linked with
 * aria-describedby, so screen readers announce it and keyboard users see it on focus.
 */
export function Tooltip({ content, children, className }: { content: string; children: React.ReactNode; className?: string }) {
  const id = React.useId();
  return (
    <span className={cn("group relative inline-flex", className)}>
      <span tabIndex={0} aria-describedby={id} className="cursor-help rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {children}
      </span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-20 mb-1 w-max max-w-[16rem] -translate-x-1/2 rounded bg-foreground px-2 py-1 text-xs font-normal text-background opacity-0 shadow transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}
