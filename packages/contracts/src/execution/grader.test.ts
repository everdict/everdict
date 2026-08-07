import { describe, expect, it } from "vitest";
import { type Score, ScoreSchema, isMeasured, measuredScores, sanitizeScore } from "./grader.js";

// The measurement gate and the contract sanitizer are the kernel's atoms — every aggregate in every package
// stands on them, yet they were tested only transitively through their consumers. This file is their own
// truth table.

describe("isMeasured — the single measured gate", () => {
  it("reads the modern status stamp first, whatever the other fields say", () => {
    expect(isMeasured({ graderId: "g", metric: "m", value: 0, status: "measured" })).toBe(true);
    expect(isMeasured({ graderId: "g", metric: "m", value: 0, status: "unmeasured" })).toBe(false);
    expect(isMeasured({ graderId: "g", metric: "m", value: 0, status: "invalid" })).toBe(false);
    // a status stamp overrides the sentinel in both directions
    expect(
      isMeasured({ graderId: "g", metric: "m", value: 1, status: "measured", detail: "[grader-error] quoted" }),
    ).toBe(true);
    expect(isMeasured({ graderId: "g", metric: "m", value: 1, pass: true, status: "unmeasured" })).toBe(false);
  });

  it("normalizes the two legacy sentinel shapes (no status, no pass, sentinel detail) as unmeasured", () => {
    expect(isMeasured({ graderId: "g", metric: "m", value: 0, detail: "[grader-error] 503" })).toBe(false);
    expect(isMeasured({ graderId: "g", metric: "m", value: 0, detail: "skipped: no ANTHROPIC_API_KEY" })).toBe(false);
  });

  it("keeps a real measurement whose prose merely opens like a sentinel — pass presence wins", () => {
    expect(isMeasured({ graderId: "g", metric: "m", value: 1, pass: true, detail: "skipped: 3 optional steps" })).toBe(
      true,
    );
    expect(
      isMeasured({ graderId: "g", metric: "m", value: 0, pass: false, detail: "[grader-error] in the reasoning" }),
    ).toBe(true);
  });

  it("treats plain rows (no status, no sentinel) and non-string details as measured", () => {
    expect(isMeasured({ graderId: "g", metric: "m", value: 0.5 })).toBe(true);
    expect(isMeasured({ graderId: "g", metric: "m", value: 0, detail: { structured: "verdict" } })).toBe(true);
  });

  it("measuredScores filters through the same gate", () => {
    const rows: Score[] = [
      { graderId: "g", metric: "m", value: 1, pass: true },
      { graderId: "g", metric: "m", value: 0, status: "unmeasured", reason: "grader_error", retryable: true },
    ];
    expect(measuredScores(rows)).toHaveLength(1);
  });
});

describe("sanitizeScore — the contract-violation boundary", () => {
  it("passes a healthy score through untouched (same object)", () => {
    const score: Score = { graderId: "g", metric: "m", value: 0.5, pass: true };
    expect(sanitizeScore(score)).toBe(score);
  });

  it("turns a non-finite value into a visible INVALID score, never a number", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = sanitizeScore({ graderId: "g", metric: "m", value });
      expect(out.status).toBe("invalid");
      expect(out.reason).toBe("contract_violation");
      expect(out.retryable).toBe(false);
      expect(out.value).toBe(0); // a placeholder the isMeasured gate keeps out of every aggregate
      expect(isMeasured(out)).toBe(false);
    }
  });

  it("negative zero is a legitimate finite value — not a contract violation", () => {
    expect(sanitizeScore({ graderId: "g", metric: "m", value: -0 }).status).toBeUndefined();
  });

  it("repairs empty identifiers so the invalid row still has an address", () => {
    const noMetric = sanitizeScore({ graderId: "g", metric: "", value: 1 });
    expect(noMetric.status).toBe("invalid");
    expect(noMetric.metric).toBe("g"); // falls back to the grader id
    const noGrader = sanitizeScore({ graderId: "", metric: "m", value: 1 });
    expect(noGrader.graderId).toBe("unknown");
    expect(noGrader.metric).toBe("m");
    const neither = sanitizeScore({ graderId: "", metric: "", value: 1 });
    expect(neither.graderId).toBe("unknown");
    expect(neither.metric).toBe("unknown");
  });
});

describe("ScoreSchema — wire shape", () => {
  it("round-trips a status-less legacy row unchanged (absent status = measured by the gate, not a default)", () => {
    const legacy = { graderId: "g", metric: "m", value: 0.5, pass: true };
    const parsed = ScoreSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed.status).toBeUndefined(); // the schema does NOT inject "measured" — read-time normalization owns it
    expect(isMeasured(parsed)).toBe(true);
  });

  it("rejects an unknown status or reason instead of defaulting", () => {
    expect(() => ScoreSchema.parse({ graderId: "g", metric: "m", value: 0, status: "maybe" })).toThrow();
    expect(() =>
      ScoreSchema.parse({ graderId: "g", metric: "m", value: 0, status: "unmeasured", reason: "vibes" }),
    ).toThrow();
  });
});
