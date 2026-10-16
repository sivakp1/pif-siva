"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface TabDef {
  id: string;
  label: string;
  content: React.ReactNode;
}

/** WAI-ARIA tabs with roving focus (arrow keys, Home/End). */
export function Tabs({ tabs, initial, label }: { tabs: TabDef[]; initial?: string; label: string }) {
  const [active, setActive] = React.useState(initial ?? tabs[0]?.id ?? "");
  const baseId = React.useId();
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const tab = tabs[next];
    if (tab) {
      setActive(tab.id);
      refs.current[tab.id]?.focus();
    }
  };

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 border-b">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            id={`${baseId}-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={active === t.id}
            aria-controls={`${baseId}-panel-${t.id}`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => setActive(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          id={`${baseId}-panel-${t.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${t.id}`}
          hidden={active !== t.id}
          tabIndex={0}
          className="pt-4 focus-visible:outline-none"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
