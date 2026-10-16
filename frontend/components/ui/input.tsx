import * as React from "react";
import { cn } from "@/lib/utils";

const base =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 " +
  "aria-[invalid=true]:border-destructive";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(base, "h-9", className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(base, "min-h-[96px] font-mono", className)} {...props} />;
  },
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(base, "h-9 py-1", className)} {...props}>
      {children}
    </select>
  );
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-sm font-medium leading-tight", className)} {...props} />;
}

export function FieldError({ id, messages }: { id: string; messages?: string[] }) {
  if (!messages?.length) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs font-medium text-destructive">
      {messages.join(" ")}
    </p>
  );
}
