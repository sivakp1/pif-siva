// FE-14: span highlighting by splitting the string at offsets — the pieces are rendered as React
// text nodes, with highlighted pieces wrapped in <mark>. No HTML is ever parsed.
//
// Offsets from pif_core (Python) count Unicode code points, so we split on code points rather than
// UTF-16 code units; otherwise astral characters (emoji, some CJK) would shift every later span.

export interface Span {
  start: number;
  end: number;
  /** Short label (e.g. finding category) shown as the mark's title. */
  label?: string;
}

export interface TextPiece {
  text: string;
  highlighted: boolean;
  labels: string[];
}

export function splitAtSpans(text: string, spans: readonly Span[]): TextPiece[] {
  const chars = Array.from(text);
  const n = chars.length;
  if (n === 0) return [];

  // Clamp, drop empty/invalid spans.
  const valid = spans
    .map((s) => ({ start: Math.max(0, Math.min(n, Math.floor(s.start))), end: Math.max(0, Math.min(n, Math.floor(s.end))), label: s.label }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);

  if (valid.length === 0) return [{ text, highlighted: false, labels: [] }];

  // Boundaries at every span edge; each elementary interval is highlighted if any span covers it.
  const cuts = new Set<number>([0, n]);
  for (const s of valid) {
    cuts.add(s.start);
    cuts.add(s.end);
  }
  const points = Array.from(cuts).sort((a, b) => a - b);

  const pieces: TextPiece[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const covering = valid.filter((s) => s.start <= a && s.end >= b);
    const labels = Array.from(new Set(covering.map((s) => s.label).filter((l): l is string => Boolean(l))));
    const piece: TextPiece = { text: chars.slice(a, b).join(""), highlighted: covering.length > 0, labels };
    const prev = pieces[pieces.length - 1];
    // Merge adjacent pieces with the same state and labels.
    if (prev && prev.highlighted === piece.highlighted && prev.labels.join("|") === piece.labels.join("|")) {
      prev.text += piece.text;
    } else {
      pieces.push(piece);
    }
  }
  return pieces;
}
