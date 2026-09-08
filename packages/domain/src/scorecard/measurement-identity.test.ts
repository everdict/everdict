import { normalizeScore, sanitizeScore } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { caseResultDigest } from "./case-result-digest.js";
import { judgeFamilyOf } from "./judge-execution-spans.js";
import { stripJudgeScores } from "./scoring-plan.js";
import { DEFAULT_VERDICT_POLICY, DEFAULT_VERDICT_POLICY_V11, evaluateVerdict } from "./verdict-policy.js";

describe("structured measurement identities", () => {
  it("an inline criterion cannot become a registered judge with the same display name", () => {
    const inline = sanitizeScore(
      { graderId: "judge", metric: "judge:x", value: 0, pass: false },
      { kind: "grader", id: "judge", ownsJudgeVerdict: true },
    );
    const registered = sanitizeScore(
      { graderId: "x", metric: "judge:x", value: 1, pass: true },
      { kind: "judge", id: "x" },
    );
    expect(evaluateVerdict({ scores: [inline, registered] }).verdict).toBe(true);
    expect(evaluateVerdict({ scores: [inline, registered] }, DEFAULT_VERDICT_POLICY_V11).verdict).toBe(false);
    expect(normalizeScore(inline).measurement?.criterion).toBe("x");
  });
  it("names every contributing measurement and its original score index", () => {
    const scores = [
      { graderId: "g", metric: "m", status: "unmeasured" as const, reason: "grader_error" as const, retryable: true },
      sanitizeScore({ graderId: "g", metric: "m", value: 1, pass: true }, { kind: "grader", id: "g" }),
      sanitizeScore({ graderId: "g", metric: "m", value: 0, pass: false }, { kind: "grader", id: "g" }),
    ];
    const basis = evaluateVerdict({ scores }).basis;
    expect(basis?.deciders[0]?.measurementRefs?.map((r) => r.index)).toEqual([1, 2]);
    expect(basis?.deciders[0]?.measurementRefs?.[0]?.digest).toMatch(/^sha256:/);
    expect(basis?.policyDigest).toMatch(/^sha256:/);
  });
  it("supports an explicit sealed authority order without changing historical policies", () => {
    const scores = [
      { graderId: "s", metric: "state", value: 0, pass: false },
      { graderId: "j", metric: "judge", value: 1, pass: true },
    ];
    expect(
      evaluateVerdict({ scores }, { ...DEFAULT_VERDICT_POLICY, authorityOrder: ["judge", "objective", "ground_truth"] })
        .verdict,
    ).toBe(true);
    expect(evaluateVerdict({ scores }, DEFAULT_VERDICT_POLICY_V11).verdict).toBe(false);
  });
});

it("rescoring a registered judge cannot strip an inline criterion with its name", () => {
  const inline = sanitizeScore(
    { graderId: "inline", metric: "judge:x", value: 0, pass: false },
    { kind: "grader", id: "inline", ownsJudgeVerdict: true },
  );
  const registered = sanitizeScore(
    { graderId: "x", metric: "judge:x", value: 1, pass: true },
    { kind: "judge", id: "x" },
  );
  expect(stripJudgeScores([inline, registered], [{ id: "x" }])).toEqual([inline]);
  expect(judgeFamilyOf(inline)).toBeUndefined();
  expect(judgeFamilyOf(registered)).toBe("x");
});

it("the collector replaces a claimed producer and measurement references survive normalization", () => {
  const score = sanitizeScore(
    {
      graderId: "g",
      metric: "quality",
      value: 1,
      pass: true,
      traceEvents: [],
      measurement: { producer: { kind: "judge", id: "stolen" }, metric: "state" },
    },
    { kind: "grader", id: "g" },
  );
  expect(score.measurement).toEqual({ producer: { kind: "grader", id: "g" }, metric: "quality" });
  expect(evaluateVerdict({ scores: [score] }).basis).toEqual(
    evaluateVerdict({ scores: [normalizeScore(score)] }).basis,
  );
});

it("priority chooses a definition while preserving disagreements between its producers", () => {
  const scores = ["first", "second"].map((id, i) =>
    sanitizeScore(
      { graderId: id, metric: "state", value: i === 0 ? 1 : 0, pass: i === 0 },
      { kind: "grader", id, ownsMetrics: ["state"] },
    ),
  );
  for (const ordered of [scores, [...scores].reverse()]) {
    const result = evaluateVerdict({ scores: ordered });
    expect(result.verdict).toBe(false);
    expect(result.basis?.deciders).toHaveLength(2);
  }
});

it("historical duplicate attribution keeps the first failing measurement", () => {
  const scores = ["pass", "first-fail", "second-fail"].map((id, i) => ({
    graderId: id,
    metric: "state",
    value: i === 0 ? 1 : 0,
    pass: i === 0,
  }));
  expect(evaluateVerdict({ scores }, DEFAULT_VERDICT_POLICY_V11).basis?.deciders[0]?.graderId).toBe("first-fail");
});

it("retains the historical normalization digest while carrying new observation assessments", () => {
  const score = {
    graderId: "judge",
    metric: "judge",
    value: 1,
    pass: true,
    observationAssessment: { status: "consistent" as const },
  };
  const legacy = {
    caseId: "c",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt" as const, output: "done" },
    scores: [score],
  };
  expect(caseResultDigest(legacy)).toBe(
    caseResultDigest({ ...legacy, scores: [{ graderId: "judge", metric: "judge", value: 1, pass: true }] }),
  );
  const modern = sanitizeScore(score, { kind: "grader", id: "judge", ownsJudgeVerdict: true });
  const normalized = normalizeScore(modern);
  expect(normalized.status).toBe("measured");
  if (normalized.status === "measured") expect(normalized.observationAssessment).toEqual({ status: "consistent" });
});
