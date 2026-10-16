"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SwitchProps {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({ id, checked, onCheckedChange, label, disabled, className }: SwitchProps) {
  const autoId = React.useId();
  const switchId = id ?? autoId;
  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50",
          checked ? "bg-primary" : "bg-slate-400",
        )}
      >
        <span className={cn("block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4" : "translate-x-0")} />
      </button>
      <label htmlFor={switchId} className="text-sm">
        {label}
        <span className="sr-only">{checked ? " (on)" : " (off)"}</span>
      </label>
    </div>
  );
}
