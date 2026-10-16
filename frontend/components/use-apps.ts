"use client";

import * as React from "react";
import { apiFetch } from "@/lib/api-client";
import type { App } from "@/lib/schemas";
import { toDisplayError, type DisplayError } from "@/components/api-error";

export function useApps() {
  const [apps, setApps] = React.useState<App[] | null>(null);
  const [error, setError] = React.useState<DisplayError | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ apps: App[] }>("/api/apps");
      setApps(res.apps);
      setError(null);
    } catch (e) {
      setError(toDisplayError(e));
      setApps((prev) => prev ?? []);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return { apps, error, reload };
}
