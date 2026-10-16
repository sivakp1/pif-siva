"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type ToastTone = "info" | "success" | "error";
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastApi {
  toast: (t: Omit<ToastItem, "id">) => void;
}

const ToastContext = React.createContext<ToastApi>({ toast: () => {} });

export function useToast() {
  return React.useContext(ToastContext);
}

const toneClasses: Record<ToastTone, string> = {
  info: "border-blue-300 bg-white text-slate-900",
  success: "border-green-400 bg-white text-slate-900",
  error: "border-red-400 bg-white text-slate-900",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const counter = React.useRef(0);

  const dismiss = React.useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const toast = React.useCallback(
    (t: Omit<ToastItem, "id">) => {
      const id = ++counter.current;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), 8000);
    },
    [dismiss],
  );

  const api = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className={cn("pointer-events-auto rounded-md border-l-4 border p-3 shadow-lg", toneClasses[t.tone])}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">{t.title}</p>
                {t.description ? <p className="mt-0.5 break-words text-xs text-slate-700">{t.description}</p> : null}
              </div>
              <button type="button" aria-label="Dismiss notification" className="rounded px-1 text-slate-600 hover:text-slate-900" onClick={() => dismiss(t.id)}>
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
