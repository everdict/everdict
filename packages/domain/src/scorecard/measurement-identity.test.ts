import { type ScoreProducer, normalizeScore, sanitizeScore } from "@everdict/contracts";
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

// ── REVIEW 2026-09-09 R4: inline criterion coordinates collapsed during collection ─────────────────
//
// The collector parsed the display metric for the criterion instead of reading the shape the producer was
// constructed with: it tried `judge:<producerId>:` first and fell back to `judge:`. For a producer whose id
// is literally `judge` — the inline judge grader's default — those two readings answer the same question, so
// the criterion `x` (`judge:x`) and the criterion `judge:x` (`judge:judge:x`) landed on ONE measurement
// identity. `dedupeByMetric` keys on exactly those four coordinates, so the two combined into one decider and
// a criterion-specific policy clause covered a criterion nobody named. `RubricSpecSchema` permits both ids,
// and the judge already emits the right coordinates — they were overwritten by this parse.
//
// Seen RED before the repair with: "expected 'x' to be 'judge:x'".
describe("a criterion's coordinates come from the producer's construction, not from its label", () => {
  // The producer descriptor the settle used to build for an inline judge row: judge authority, and nothing
  // said about which of the two criterion shapes the construction writes.
  const bare = { kind: "grader", id: "judge", ownsJudgeVerdict: true } as const;
  // …and the one it builds now, for a spec `makeGraders` constructs with `namespaceCriteria` (arch-review 19).
  const namespaced = { ...bare, namespacesJudgeCriteria: true } as const;
  const criterionOf = (metric: string, producer: ScoreProducer) =>
    sanitizeScore({ graderId: "judge", metric, value: 1, pass: true }, producer).measurement?.criterion;
  // Criteria are DIAGNOSTIC under the default policy — the review says so itself — so a policy that lets them
  // decide is what makes the collision observable in a verdict at all.
  const deciding = (criterion: { id: string } | "any") => ({
    ...DEFAULT_VERDICT_POLICY,
    metrics: [
      { match: { metric: "judge" }, criterion, authority: "judge" as const },
      ...DEFAULT_VERDICT_POLICY.metrics,
    ],
  });
  const scored = (metric: string, pass: boolean) =>
    sanitizeScore({ graderId: "judge", metric, value: pass ? 1 : 0, pass }, bare);

  it("reads the criterion off the shape the producer writes, for both shapes", () => {
    // Given: a producer that leaves its criteria at `judge:<criterion>`
    expect(criterionOf("judge:x", bare)).toBe("x");
    expect(criterionOf("judge:judge:x", bare)).toBe("judge:x");
    // …and one that namespaces them under its own id
    expect(criterionOf("judge:judge:x", namespaced)).toBe("x");
    expect(criterionOf("judge:judge:judge:x", namespaced)).toBe("judge:x");
  });

  it("does not combine two distinct criteria into one decider", () => {
    // Given: the failing criterion `x` and the passing criterion `judge:x`, in one case
    const basis = evaluateVerdict(
      { scores: [scored("judge:x", false), scored("judge:judge:x", true)] },
      deciding("any"),
    ).basis;
    // Then: deduplication sees two measurements, not one whose disagreement was folded away
    expect(basis?.deciders).toHaveLength(2);
    expect(basis?.deciders.map((d) => d.measurement?.criterion).sort()).toEqual(["judge:x", "x"]);
  });

  it("applies a criterion-specific policy clause to the criterion it names and to no other", () => {
    const scores = [scored("judge:x", false), scored("judge:judge:x", true)];
    // Given: a policy under which ONLY the criterion `x` decides — the failing one
    expect(evaluateVerdict({ scores }, deciding({ id: "x" })).verdict).toBe(false);
    // …and one under which only `judge:x` decides — the passing one. Before the repair both clauses matched
    // both rows, because both rows carried the criterion `x`.
    expect(evaluateVerdict({ scores }, deciding({ id: "judge:x" })).verdict).toBe(true);
  });

  it("does not promote a judge-family row that carries neither the overall name nor the declared prefix", () => {
    // Given: a row a namespaced producer's construction cannot have written — a runner submitting `judge:x`
    // under a case that declared the inline judge.
    const stray = sanitizeScore({ graderId: "judge", metric: "judge:x", value: 0, pass: false }, namespaced);
    // Then: it keeps the reading it already had — canonical metric `judge` with a criterion, which the
    // default policy treats as DIAGNOSTIC. Leaving the metric verbatim would have matched
    // `{prefix: "judge:", segments: 2}` instead and made a producer-submitted row DECIDE the case.
    expect(stray.measurement).toEqual({
      producer: { kind: "grader", id: "judge" },
      metric: "judge",
      criterion: "x",
    });
    const overall = sanitizeScore({ graderId: "judge", metric: "judge", value: 1, pass: true }, namespaced);
    expect(evaluateVerdict({ scores: [overall, stray] }).verdict, "a diagnostic row decided the case").toBe(true);
  });

  it("leaves the overall row and a registered judge's own family unchanged", () => {
    expect(sanitizeScore({ graderId: "judge", metric: "judge", value: 1, pass: true }, namespaced).measurement).toEqual(
      { producer: { kind: "grader", id: "judge" }, metric: "judge" },
    );
    expect(criterionOf("judge:q:x", { kind: "judge", id: "q" })).toBe("x");
    expect(criterionOf("judge:q:q:x", { kind: "judge", id: "q" })).toBe("q:x");
  });
});
