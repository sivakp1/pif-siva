"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface TagInputProps {
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Return an error message to reject a tag. */
  validate?: (value: string) => string | null;
  describedBy?: string;
}

/** Tag input: Enter or comma adds, Backspace on empty removes last; each tag has a remove button. */
export function TagInput({ id, label, values, onChange, placeholder, disabled, validate, describedBy }: TagInputProps) {
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const errId = `${id}-tag-error`;

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    const err = validate?.(v) ?? null;
    if (err) {
      setError(err);
      return;
    }
    if (!values.includes(v)) onChange([...values, v]);
    setDraft("");
    setError(null);
  };

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div
        className={cn(
          "mt-1 flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1",
          "focus-within:ring-2 focus-within:ring-ring",
          disabled && "opacity-60",
        )}
      >
        <ul className="contents" aria-label={`${label} values`}>
          {values.map((v) => (
            <li key={v} className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs">
              <span className="truncate">{v}</span>
              {!disabled && (
                <button
                  type="button"
                  className="rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Remove ${v}`}
                  onClick={() => onChange(values.filter((x) => x !== v))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        <input
          id={id}
          value={draft}
          disabled={disabled}
          placeholder={values.length ? "" : placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error ? errId : null, describedBy].filter(Boolean).join(" ") || undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm outline-none"
        />
      </div>
      {error ? (
        <p id={errId} role="alert" className="mt-1 text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
