import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, diffObjects, validatePolicy, type Policy } from "@/lib/policy";
import { PolicyUpdateRequestSchema } from "@/lib/schemas";

function withPolicy(patch: (p: Policy) => void): Policy {
  const p = structuredClone(DEFAULT_POLICY);
  patch(p);
  return p;
}

describe("policy validation (CORE-22 mirror)", () => {
  it("accepts the default policy", () => {
    expect(validatePolicy(DEFAULT_POLICY).ok).toBe(true);
  });

  it("test_AC_FE_5: flag=0.9, sanitize=0.7 is rejected with an error naming both fields on both fields", () => {
    const res = validatePolicy(withPolicy((p) => {
      p.thresholds.flag = 0.9;
      p.thresholds.sanitize = 0.7;
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const flagMsgs = res.errors["thresholds.flag"] ?? [];
    const sanitizeMsgs = res.errors["thresholds.sanitize"] ?? [];
    expect(flagMsgs.join(" ")).toMatch(/Flag threshold/);
    expect(flagMsgs.join(" ")).toMatch(/Sanitize threshold/);
    expect(sanitizeMsgs).toEqual(flagMsgs.filter((m) => m.includes("Sanitize")));
    expect(flagMsgs).toContain("Flag threshold must be ≤ Sanitize threshold");
  });

  it("rejects sanitize > block naming both fields", () => {
    const res = validatePolicy(withPolicy((p) => {
      p.thresholds.sanitize = 0.9;
      p.thresholds.block = 0.8;
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors["thresholds.block"]).toContain("Sanitize threshold must be ≤ Block threshold");
    expect(res.errors["thresholds.sanitize"]).toContain("Sanitize threshold must be ≤ Block threshold");
  });

  it("rejects flag = 0 and block > 1", () => {
    const res = validatePolicy(withPolicy((p) => {
      p.thresholds.flag = 0;
      p.thresholds.block = 1.2;
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors["thresholds.flag"]).toContain("Flag threshold must be > 0");
    expect(res.errors["thresholds.block"]).toContain("Block threshold must be ≤ 1");
  });

  it("accepts equal thresholds (≤ is inclusive)", () => {
    expect(validatePolicy(withPolicy((p) => {
      p.thresholds = { flag: 0.7, sanitize: 0.7, block: 0.7 };
    })).ok).toBe(true);
  });

  it("rejects gray zone low ≥ high naming both fields", () => {
    const res = validatePolicy(withPolicy((p) => {
      p.gray_zone = { low: 0.8, high: 0.8 };
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors["gray_zone.low"]).toContain("Gray zone low must be < Gray zone high");
    expect(res.errors["gray_zone.high"]).toContain("Gray zone low must be < Gray zone high");
  });

  it("rejects a non-numeric threshold", () => {
    const res = validatePolicy(withPolicy((p) => {
      p.thresholds.flag = Number.NaN;
    }));
    expect(res.ok).toBe(false);
  });

  it("rejects a fractional judge budget", () => {
    const res = validatePolicy(withPolicy((p) => {
      p.judge_budget = 1.5;
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.judge_budget?.[0]).toMatch(/whole number/);
  });

  it("BFF request schema enforces the same cross-field rules", () => {
    const bad = PolicyUpdateRequestSchema.safeParse({
      policy: withPolicy((p) => {
        p.thresholds.flag = 0.9;
        p.thresholds.sanitize = 0.7;
      }),
      policy_version: 3,
    });
    expect(bad.success).toBe(false);
    const good = PolicyUpdateRequestSchema.safeParse({ policy: DEFAULT_POLICY, policy_version: 3, allowed_link_domains: ["example.com"] });
    expect(good.success).toBe(true);
  });

  it("BFF request schema rejects unknown fields", () => {
    expect(PolicyUpdateRequestSchema.safeParse({ policy: DEFAULT_POLICY, policy_version: 1, extra: true }).success).toBe(false);
  });
});

describe("policy diff preview", () => {
  it("lists only changed fields with labels", () => {
    const after = withPolicy((p) => {
      p.mode = "monitor";
      p.custom_rules.deny_phrases = ["promo code"];
    });
    const rows = diffObjects(DEFAULT_POLICY, after);
    expect(rows.map((r) => r.field)).toEqual(["custom_rules.deny_phrases", "mode"]);
    expect(rows.find((r) => r.field === "mode")).toMatchObject({ label: "Mode", before: "enforce", after: "monitor" });
    expect(rows.find((r) => r.field === "custom_rules.deny_phrases")).toMatchObject({ before: "(none)", after: "promo code" });
  });

  it("is empty when nothing changed", () => {
    expect(diffObjects(DEFAULT_POLICY, structuredClone(DEFAULT_POLICY))).toEqual([]);
  });
});
