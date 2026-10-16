import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, filtersToApiQuery, filtersToSearch, parseFilters } from "@/lib/verdict-filters";

describe("verdict filters in the URL (AC-FE-8)", () => {
  it("round-trips through the query string", () => {
    const f = { ...DEFAULT_FILTERS, app: "support-bot", actions: ["block", "flag"] as ("block" | "flag")[], range: "7d" as const, minRisk: 0.6, origins: ["api" as const] };
    const qs = filtersToSearch(f);
    expect(parseFilters(new URLSearchParams(qs))).toEqual(f);
  });

  it("defaults exclude playground and produce an empty query", () => {
    expect(filtersToSearch(DEFAULT_FILTERS)).toBe("");
    expect(parseFilters(new URLSearchParams()).origins).toEqual(["api", "chat"]);
  });

  it("drops invalid values", () => {
    const f = parseFilters(new URLSearchParams("app=Bad App&action=block,nope&range=1y&min_risk=7"));
    expect(f).toEqual({ ...DEFAULT_FILTERS, actions: ["block"] });
  });

  it("builds the backend query with a time window", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const q = filtersToApiQuery({ ...DEFAULT_FILTERS, range: "1h" }, now, "abc");
    expect(q.get("from")).toBe("2026-10-16T11:00:00.000Z");
    expect(q.get("to")).toBe("2026-10-16T12:00:00.000Z");
    expect(q.get("origin")).toBe("api,chat");
    expect(q.get("cursor")).toBe("abc");
  });
});
