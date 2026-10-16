import { fmtScore } from "@/lib/format";

export interface Thresholds {
  flag: number;
  sanitize: number;
  block: number;
}

/** Risk score as a number plus a horizontal bar with the flag/sanitize/block thresholds marked (FE-06). */
export function RiskBar({ risk, thresholds }: { risk: number; thresholds?: Thresholds | null }) {
  const pct = Math.max(0, Math.min(1, risk)) * 100;
  const marks = thresholds
    ? ([
        ["Flag", thresholds.flag],
        ["Sanitize", thresholds.sanitize],
        ["Block", thresholds.block],
      ] as const)
    : [];
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums" data-testid="risk-score">
          {fmtScore(risk)}
        </span>
        <span className="text-sm text-muted-foreground">risk score (0–1)</span>
      </div>
      <div
        className="relative mt-2 h-3 w-full rounded-full bg-slate-200"
        role="meter"
        aria-label="Risk score"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(risk.toFixed(2))}
      >
        <div className="h-3 rounded-full bg-slate-700" style={{ width: `${pct}%` }} />
        {marks.map(([label, v]) => (
          <span key={label} aria-hidden className="absolute -top-1 h-5 w-0.5 bg-slate-900" style={{ left: `${v * 100}%` }} />
        ))}
      </div>
      {marks.length ? (
        <div className="relative mt-1 h-4 text-[11px] text-muted-foreground" aria-hidden>
          {marks.map(([label, v]) => (
            <span key={label} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${v * 100}%` }}>
              {label} {fmtScore(v)}
            </span>
          ))}
        </div>
      ) : null}
      {thresholds ? (
        <p className="sr-only">
          Thresholds: flag {fmtScore(thresholds.flag)}, sanitize {fmtScore(thresholds.sanitize)}, block {fmtScore(thresholds.block)}.
        </p>
      ) : null}
    </div>
  );
}
