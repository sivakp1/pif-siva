import { splitAtSpans, type Span } from "@/lib/highlight";
import { cn } from "@/lib/utils";

/**
 * Renders untrusted text with span highlights. Everything is a React text node; highlighted
 * pieces are wrapped in <mark>. No HTML parsing, no markdown, no auto-linking (FE-14).
 */
export function HighlightedText({ text, spans, className }: { text: string; spans: Span[]; className?: string }) {
  const pieces = splitAtSpans(text, spans);
  return (
    <pre className={cn("whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed", className)}>
      {pieces.map((p, i) =>
        p.highlighted ? (
          <mark key={i} title={p.labels.join(", ") || undefined} className="rounded-sm bg-yellow-200 px-0.5 text-slate-950 underline decoration-dotted">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </pre>
  );
}

export function PlainText({ text, className, scrollable }: { text: string; className?: string; scrollable?: boolean }) {
  return (
    <pre
      // Scrollable regions must be keyboard-focusable (WCAG 2.1.1).
      tabIndex={scrollable ? 0 : undefined}
      className={cn("whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed", scrollable && "max-h-48 overflow-auto", className)}
    >
      {text}
    </pre>
  );
}
