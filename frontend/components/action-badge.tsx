import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// FE-06: fixed colors plus a text label and a glyph, so the action is never conveyed by color alone.
const STYLES: Record<string, { cls: string; glyph: string }> = {
  allow: { cls: "border-green-700 bg-green-100 text-green-900", glyph: "✓" },
  flag: { cls: "border-amber-600 bg-amber-100 text-amber-950", glyph: "⚑" },
  sanitize: { cls: "border-blue-700 bg-blue-100 text-blue-900", glyph: "✂" },
  block: { cls: "border-red-700 bg-red-100 text-red-900", glyph: "⛔" },
};

export const ACTION_COLORS: Record<string, string> = {
  allow: "#15803d",
  flag: "#d97706",
  sanitize: "#1d4ed8",
  block: "#b91c1c",
};

export function actionLabel(action: string, wouldAction?: string | null): string {
  const a = action.toUpperCase();
  if (wouldAction && wouldAction !== action) return `${a} (would ${wouldAction.toUpperCase()})`;
  return a;
}

export function ActionBadge({ action, wouldAction, className }: { action: string; wouldAction?: string | null; className?: string }) {
  const style = STYLES[action] ?? { cls: "border-slate-400 bg-slate-100 text-slate-900", glyph: "•" };
  return (
    <Badge className={cn(style.cls, className)} data-action={action}>
      <span aria-hidden>{style.glyph}</span>
      <span>{actionLabel(action, wouldAction)}</span>
    </Badge>
  );
}
