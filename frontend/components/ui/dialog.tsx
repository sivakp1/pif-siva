"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// Modal built on the native <dialog> element: showModal() gives focus containment, Esc to close
// and an inert background without extra dependencies.

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  /** When false, Esc and backdrop clicks do not close the dialog. */
  dismissible?: boolean;
}

export function Dialog({ open, onClose, title, description, children, footer, className, dismissible = true }: DialogProps) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descId = React.useId();

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      className={cn(
        "w-[calc(100%-2rem)] max-w-lg rounded-lg border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50",
        className,
      )}
    >
      <div className="flex max-h-[85vh] flex-col">
        <div className="border-b p-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description ? (
            <p id={descId} className="mt-1 text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t p-4">{footer}</div> : null}
      </div>
    </dialog>
  );
}
