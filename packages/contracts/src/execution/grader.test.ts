import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Score,
  ScoreSchema,
  ScoreUnionSchema,
  isMeasured,
  measuredScores,
  normalizeScore,
  renderScoreDetail,
  sanitizeScore,
} from "./grader.js";

// The measurement algebra is the kernel's atom — every aggregate in every package stands on it. This file is
// its truth table: what the union refuses, what the normalizer maps, and that the gate really NARROWS.

describe("ScoreUnionSchema — illegal states are unrepresentable", () => {
  it("refuses a measured score carrying an unmeasured score's fields", () => {
    // The old flat schema parsed this happily — three independent optionals and no refinement.
    expect(() =>
      ScoreUnionSchema.parse({ graderId: "g", metric: "m", value: 0, status: "measured", reason: "grader_error" }),
    ).toThrow();
    expect(() =>
      ScoreUnionSchema.parse({ graderId: "g", metric: "m", value: 0, status: "measured", retryable: true }),
    ).toThrow();
  });

  it("refuses an unmeasured or invalid score carrying a value", () => {
    expect(() =>
      ScoreUnionSchema.parse({
        graderId: "g",
        metric: "m",
        value: 0,
        status: "unmeasured",
        reason: "grader_error",
        retryable: true,
      }),
    ).toThrow();
    expect(() =>
      ScoreUnionSchema.parse({
        graderId: "g",
        metric: "m",
        value: 0,
        status: "invalid",
        reason: "contract_violation",
      }),
    ).toThrow();
  });

  it("requires an unmeasured score to say WHY and whether re-scoring can recover it", () => {
    expect(() =>
      ScoreUnionSchema.parse({ graderId: "g", metric: "m", status: "unmeasured", retryable: true }),
    ).toThrow();
    expect(() =>
      ScoreUnionSchema.parse({ graderId: "g", metric: "m", status: "unmeasured", reason: "grader_error" }),
    ).toThrow();
    expect(() =>
      ScoreUnionSchema.parse({ graderId: "g", metric: "m", status: "unmeasured", reason: "vibes", retryable: true }),
    ).toThrow();
  });

  it("accepts the three legal shapes, including a status-less producer literal", () => {
    expect(ScoreUnionSchema.parse({ graderId: "g", metric: "m", value: 0.5, pass: true })).toEqual({
      graderId: "g",
      metric: "m",
      value: 0.5,
      pass: true,
    });
    expect(
      ScoreUnionSchema.parse({
        graderId: "g",
        metric: "m",
        status: "unmeasured",
        reason: "missing_secret",
        retryable: false,
      }).status,
    ).toBe("unmeasured");
    expect(
      ScoreUnionSchema.parse({ graderId: "g", metric: "m", status: "invalid", reason: "contract_violation" }).status,
    ).toBe("invalid");
  });
});

describe("normalizeScore — the ONE reader-side normalizer", () => {
  it("carries the judge's traceEvents transport slot through normalization — a field the normalizer forgets is a field every read drops", () => {
    const spans = [{ t: 3, kind: "span" as const, name: "judge:q:llm_call", attributes: { model: "m" } }];
    const measured = normalizeScore({ graderId: "g", metric: "judge:q", value: 1, pass: true, traceEvents: spans });
    expect(measured.traceEvents).toEqual(spans);
    const unmeasured = normalizeScore({
      graderId: "g",
      metric: "judge:q",
      status: "unmeasured",
      reason: "grader_error",
      retryable: true,
      traceEvents: spans, // a failed judge still called — the call is what makes the row diagnosable
    });
    expect(unmeasured.traceEvents).toEqual(spans);
  });

  it("stamps a plain legacy row as measured (it never was anything else)", () => {
    const out = normalizeScore({ graderId: "g", metric: "m", value: 0.5, pass: true });
    expect(out).toEqual({ graderId: "g", metric: "m", value: 0.5, pass: true, status: "measured" });
    expect(isMeasured(out)).toBe(true);
  });

  it("maps the two legacy detail sentinels onto unmeasured with the producer's own semantics", () => {
    const graderError = normalizeScore({ graderId: "g", metric: "m", value: 0, detail: "[grader-error] 503" });
    expect(graderError).toEqual({
      graderId: "g",
      metric: "m",
      detail: "[grader-error] 503",
      status: "unmeasured",
      reason: "grader_error",
      retryable: true, // safeGrade's throw is transient by default — re-scoring can recover it
    });
    const skipped = normalizeScore({ graderId: "g", metric: "m", value: 0, detail: "skipped: no ANTHROPIC_API_KEY" });
    expect(skipped).toEqual({
      graderId: "g",
      metric: "m",
      detail: "skipped: no ANTHROPIC_API_KEY",
      status: "unmeasured",
      reason: "unsupported", // a pre-status skip did not record its cause — fail closed, never retryable
      retryable: false,
    });
  });

  it("keeps a real measurement whose prose merely opens like a sentinel — pass presence wins", () => {
    expect(
      normalizeScore({ graderId: "g", metric: "m", value: 1, pass: true, detail: "skipped: 3 optional steps" }),
    ).toMatchObject({ status: "measured", value: 1 });
    expect(
      normalizeScore({ graderId: "g", metric: "m", value: 0, pass: false, detail: "[grader-error] in the reasoning" }),
    ).toMatchObject({ status: "measured", value: 0 });
  });

  it("drops the placeholder value off a persisted unmeasured row", () => {
    const out = normalizeScore({
      graderId: "judge",
      metric: "judge:x",
      value: 0,
      status: "unmeasured",
      reason: "missing_secret",
      retryable: false,
      detail: "skipped: no key",
    });
    expect("value" in out).toBe(false);
    expect(out.status).toBe("unmeasured");
  });

  it("falls back closed when a persisted unmeasured row cannot say why", () => {
    const out = normalizeScore({ graderId: "g", metric: "m", value: 0, status: "unmeasured", reason: "vibes" });
    expect(out).toMatchObject({ status: "unmeasured", reason: "unsupported", retryable: false });
  });

  it("turns a non-finite value or an empty identifier into invalid, never a number", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = normalizeScore({ graderId: "g", metric: "m", value });
      expect(out).toMatchObject({ status: "invalid", reason: "contract_violation" });
      expect("value" in out).toBe(false);
      expect(isMeasured(out)).toBe(false);
    }
    expect(normalizeScore({ graderId: "g", metric: "", value: 1 }).status).toBe("invalid");
    expect(normalizeScore({ graderId: "", metric: "m", value: 1 }).status).toBe("invalid");
  });

  it("negative zero is a legitimate finite measurement", () => {
    expect(normalizeScore({ graderId: "g", metric: "m", value: -0 }).status).toBe("measured");
  });

  it("strips the placeholder value and retryable off a persisted invalid row", () => {
    const out = normalizeScore({
      graderId: "g",
      metric: "m",
      value: 0,
      status: "invalid",
      reason: "contract_violation",
      retryable: false,
      detail: "[invalid-score] value=NaN",
    });
    expect(out).toEqual({
      graderId: "g",
      metric: "m",
      status: "invalid",
      reason: "contract_violation",
      detail: "[invalid-score] value=NaN",
    });
  });

  it("is wired INTO ScoreSchema, so every nested parse boundary normalizes by construction", () => {
    const parsed = ScoreSchema.parse({ graderId: "g", metric: "m", value: 0, detail: "[grader-error] 503" });
    expect(parsed).toMatchObject({ status: "unmeasured", reason: "grader_error" });
    // and an array of them, which is how CaseResultSchema embeds it
    expect(z.array(ScoreSchema).parse([{ graderId: "g", metric: "m", value: 1 }])[0]).toMatchObject({
      status: "measured",
    });
  });
});

describe("isMeasured — the single measured gate", () => {
  it("narrows to MeasuredScore, so `.value` is reachable ONLY behind the gate (compile-time)", () => {
    const rows: Score[] = [
      { graderId: "g", metric: "m", value: 1, pass: true },
      { graderId: "g", metric: "m", status: "unmeasured", reason: "grader_error", retryable: true },
      { graderId: "g", metric: "m", status: "invalid", reason: "contract_violation" },
    ];
    // No cast, no `as`: the predicate is what makes `.value` legal here at all.
    const values = rows.filter(isMeasured).map((s) => s.value);
    expect(values).toEqual([1]);
    expect(measuredScores(rows)).toHaveLength(1);
  });

  it("reads the status stamp, never the detail prose (legacy tolerance lives in the normalizer alone)", () => {
    expect(
      isMeasured({ graderId: "g", metric: "m", value: 0, status: "measured", detail: "[grader-error] quoted" }),
    ).toBe(true);
    expect(isMeasured({ graderId: "g", metric: "m", value: 0 })).toBe(true);
    expect(
      isMeasured({ graderId: "g", metric: "m", status: "unmeasured", reason: "policy_skip", retryable: false }),
    ).toBe(false);
    expect(isMeasured({ graderId: "g", metric: "m", status: "invalid", reason: "contract_violation" })).toBe(false);
  });
});

describe("sanitizeScore — the producer-side twin of the invalid branch", () => {
  it("passes a healthy score through untouched (same object)", () => {
    const score: Score = { graderId: "g", metric: "m", value: 0.5, pass: true };
    expect(sanitizeScore(score)).toBe(score);
  });

  it("turns a non-finite value into a value-LESS invalid score", () => {
    const out = sanitizeScore({ graderId: "g", metric: "m", value: Number.NaN });
    expect(out).toMatchObject({ status: "invalid", reason: "contract_violation" });
    expect("value" in out).toBe(false);
    expect(isMeasured(out)).toBe(false);
  });

  it("repairs empty identifiers so the invalid row still has an address", () => {
    expect(sanitizeScore({ graderId: "g", metric: "", value: 1 })).toMatchObject({ metric: "g", status: "invalid" });
    expect(sanitizeScore({ graderId: "", metric: "m", value: 1 })).toMatchObject({
      graderId: "unknown",
      metric: "m",
    });
    expect(sanitizeScore({ graderId: "", metric: "", value: 1 })).toMatchObject({
      graderId: "unknown",
      metric: "unknown",
    });
  });

  it("repairs a value-less variant's empty identifiers without inventing a number", () => {
    const out = sanitizeScore({
      graderId: "g",
      metric: "",
      status: "unmeasured",
      reason: "policy_skip",
      retryable: false,
    });
    expect(out).toMatchObject({ status: "invalid", metric: "g" });
    expect("value" in out).toBe(false);
  });
});

describe("renderScoreDetail — an open field still has to reach a reader", () => {
  it("renders every shape a grader actually writes", () => {
    // A threshold grader writes a sentence…
    expect(renderScoreDetail("below 0.8")).toBe("below 0.8");
    // …a model judge writes an object, which is what the narrowing consumer dropped entirely.
    expect(renderScoreDetail({ reasoning: "the agent never opened the form", evidence: "step 4" })).toBe(
      "reasoning: the agent never opened the form\nevidence: step 4",
    );
    // …a code judge writes whatever its script returned. A shape is better than silence.
    expect(renderScoreDetail({ exitCode: 3 })).toBe('{"exitCode":3}');
    expect(renderScoreDetail([{ reason: "a" }, { reason: "b" }])).toBe("reason: a\nreason: b");
    // Absence is absence — the caller omits the field rather than exporting an empty comment.
    expect(renderScoreDetail(undefined)).toBe("");
    expect(renderScoreDetail(null)).toBe("");
    expect(renderScoreDetail("")).toBe("");
  });

  it("is total — an unserialisable detail still renders something", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(renderScoreDetail(circular).length).toBeGreaterThan(0);
    expect(renderScoreDetail(123)).toBe("123");
    expect(renderScoreDetail(false)).toBe("false");
  });

  it("truncates rather than exporting an unbounded blob", () => {
    const rendered = renderScoreDetail("x".repeat(9_000));
    expect(rendered.length).toBe(4_000);
    expect(rendered.endsWith("…")).toBe(true);
  });
});
