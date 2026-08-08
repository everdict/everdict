import type { CaseResult, Score, Scorecard } from "@everdict/contracts";
import { ScoreSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  caseVerdict,
  diffScorecards,
  measurementCoverage,
  metricCoverage,
  retryableUnmeasured,
  scorecardPassRate,
  summarizeScorecard,
} from "./scorecard.js";
import { DEFAULT_VERDICT_POLICY } from "./verdict-policy.js";

// Restored from the deleted packages/suite/src/suite.test.ts (P4 sweep B) — the runSuite describes moved to
// @everdict/application-control, but these pure-aggregation pins were dropped in the sweep. They pin the
// scoring semantics (metric grouping + the authority-ranked case verdict) that every dashboard relies on.

function caseResult(caseId: string, harness: string, pass: boolean, steps: number): CaseResult {
  return {
    caseId,
    harness,
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [
      { graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass },
      { graderId: "steps", metric: "tool_calls", value: steps },
    ],
  };
}

describe("measurementCoverage", () => {
  const withScores = (caseId: string, scores: Score[], failure?: CaseResult["failure"]): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores,
    ...(failure ? { failure } : {}),
  });

  it("reports how much of the score plane was an actual measurement", () => {
    const sc: Pick<Scorecard, "results"> = {
      results: [
        withScores("a", [
          { graderId: "t", metric: "tests_pass", value: 1, pass: true },
          { graderId: "j", metric: "judge:q", status: "unmeasured", reason: "grader_error", retryable: true },
        ]),
        withScores("b", [{ graderId: "t", metric: "tests_pass", value: 0, pass: false }]),
      ],
    };
    expect(measurementCoverage(sc)).toEqual({ scores: 3, unmeasured: 1, unmeasuredFraction: 1 / 3 });
  });

  it("counts over the same cases the metric plane aggregates — a no-outcome case contributes nothing", () => {
    const sc: Pick<Scorecard, "results"> = {
      results: [
        withScores("a", [{ graderId: "t", metric: "tests_pass", value: 1, pass: true }]),
        withScores("cancelled", [{ graderId: "t", metric: "tests_pass", value: 0 }], {
          code: "CANCELLED",
          stage: "run",
          message: "stopped",
          class: "infra",
          retryable: false,
        }),
      ],
    };
    expect(measurementCoverage(sc)).toMatchObject({ scores: 1, unmeasured: 0 });
  });

  it("has NO fraction when there were no scores at all — a ratio over nothing is absence, not 0", () => {
    expect(measurementCoverage({ results: [] })).toEqual({ scores: 0, unmeasured: 0 });
  });
});

describe("summarizeScorecard", () => {
  it("aggregates pass rate/mean per metric", () => {
    const sc: Scorecard = {
      suiteId: "s1",
      harness: "h@1",
      results: [caseResult("a", "h@1", true, 2), caseResult("b", "h@1", false, 4)],
    };
    const summary = summarizeScorecard(sc);
    const tests = summary.find((s) => s.metric === "tests_pass");
    expect(tests?.passRate).toBe(0.5);
    const steps = summary.find((s) => s.metric === "tool_calls");
    expect(steps?.mean).toBe(3);
  });

  it("aggregates an ORDERED enum (tier) as a distribution in ordinal order + the most-frequent mode", () => {
    // A tier grader emits Score.label with `value` as the ordering key (bronze<silver<gold ⇒ 1<2<3); averaging tiers
    // is meaningless, so the summary carries the label distribution — read in natural order — and the mode.
    const tier = (caseId: string, label: string, rank: number): CaseResult => ({
      caseId,
      harness: "h@1",
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [{ graderId: "tier", metric: "tier", value: rank, label }],
    });
    const summary = summarizeScorecard({
      suiteId: "s1",
      harness: "h@1",
      results: [tier("a", "gold", 3), tier("b", "gold", 3), tier("c", "silver", 2), tier("d", "bronze", 1)],
    });
    const m = summary.find((s) => s.metric === "tier");
    expect(m?.distribution).toEqual([
      { label: "bronze", count: 1 },
      { label: "silver", count: 1 },
      { label: "gold", count: 2 },
    ]); // natural ordinal order (value asc), NOT frequency — an ordered enum reads bronze→silver→gold
    expect(m?.mode).toBe("gold"); // mode is still the most-frequent label (count 2), independent of display order
    expect(m?.count).toBe(4);
    expect(m?.passRate).toBeUndefined(); // no pass on a categorical metric
  });

  it("aggregates an UNORDERED enum (reason) by frequency — every value 0 ⇒ count descending", () => {
    // A classification "reason" enum has no natural order, so the grader sets value 0; the distribution then falls
    // back to most-frequent-first (the natural read for a failure-reason breakdown).
    const reason = (caseId: string, label: string): CaseResult => ({
      caseId,
      harness: "h@1",
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [{ graderId: "classify", metric: "reason", value: 0, label }],
    });
    const summary = summarizeScorecard({
      suiteId: "s1",
      harness: "h@1",
      results: [
        reason("a", "correct"),
        reason("b", "correct"),
        reason("c", "timeout"),
        reason("d", "correct"),
        reason("e", "wrong"),
      ],
    });
    const m = summary.find((s) => s.metric === "reason");
    expect(m?.distribution).toEqual([
      { label: "correct", count: 3 },
      { label: "timeout", count: 1 }, // the count-1 tie breaks alphabetically (timeout < wrong)
      { label: "wrong", count: 1 },
    ]);
    expect(m?.mode).toBe("correct");
  });
});

describe("measurement status — an unmeasured score never enters an aggregate", () => {
  const result = (caseId: string, scores: Score[]): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores,
  });
  const measured = (metric: string, value: number, pass?: boolean): Score => ({
    graderId: metric,
    metric,
    value,
    ...(pass !== undefined ? { pass } : {}),
  });

  it("a grader error leaves the metric mean identical to a scorecard without that score (the core invariant)", () => {
    // Given: two cases measured at 0.8/0.6, plus one case whose grader DIED (unmeasured placeholder value 0)
    const clean: Scorecard = {
      suiteId: "s",
      harness: "h@1",
      results: [result("a", [measured("cost_usd", 0.8)]), result("b", [measured("cost_usd", 0.6)])],
    };
    const withOutage: Scorecard = {
      ...clean,
      results: [
        ...clean.results,
        result("c", [
          {
            graderId: "cost",
            metric: "cost_usd",
            status: "unmeasured",
            reason: "grader_error",
            retryable: true,
            detail: "[grader-error] boom",
          },
        ]),
      ],
    };
    // Then: the outage shifts NOTHING — mean/count equal the clean control; it shows up only as the unmeasured tally
    const cleanMetric = summarizeScorecard(clean).find((m) => m.metric === "cost_usd");
    const outageMetric = summarizeScorecard(withOutage).find((m) => m.metric === "cost_usd");
    expect(outageMetric?.mean).toBe(cleanMetric?.mean);
    expect(outageMetric?.count).toBe(cleanMetric?.count);
    expect(outageMetric?.unmeasured).toBe(1);
    expect(cleanMetric?.unmeasured).toBeUndefined();
  });

  it("legacy rows without `status` are normalized at read: [grader-error]/skipped: sentinels stay out of the mean", () => {
    // Rows persisted before the status field marked the two skip producers in detail prose only. Legacy
    // tolerance lives in the DECODER now (one place), so a legacy row only ever exists as data coming off a
    // wire or a jsonb column — which is how it enters here.
    const sc: Scorecard = {
      suiteId: "s",
      harness: "h@1",
      results: [
        result("a", [measured("judge:quality", 0.9, true)]),
        result("b", [
          ScoreSchema.parse({ graderId: "judge", metric: "judge:quality", value: 0, detail: "[grader-error] 503" }),
        ]),
        result("c", [
          ScoreSchema.parse({
            graderId: "q",
            metric: "judge:quality",
            value: 0,
            detail: "skipped: no ANTHROPIC_API_KEY",
          }),
        ]),
      ],
    };
    const m = summarizeScorecard(sc).find((s) => s.metric === "judge:quality");
    expect(m?.mean).toBe(0.9);
    expect(m?.count).toBe(1);
    expect(m?.unmeasured).toBe(2);
  });

  it("an unmeasured score cannot decide a case verdict even if it arrived carrying a pass flag", () => {
    // Unconstructible in TypeScript now — so the hostile row comes in as wire data, through the decoder.
    const hostile = ScoreSchema.parse({
      graderId: "j",
      metric: "judge:q",
      value: 0,
      pass: false,
      status: "unmeasured",
      reason: "grader_error",
      retryable: true,
    });
    expect(
      caseVerdict({
        scores: [hostile, { graderId: "custom", metric: "custom_check", value: 1, pass: true }],
      }),
    ).toBe(true); // the hostile unmeasured pass:false is ignored; the real measurement decides
  });

  it("diff never produces a delta or pass transition from an unmeasured placeholder", () => {
    const base: Scorecard = {
      suiteId: "s",
      harness: "h@1",
      results: [result("a", [measured("tests_pass", 1, true)])],
    };
    const cand: Scorecard = {
      suiteId: "s",
      harness: "h@2",
      results: [
        result("a", [
          ScoreSchema.parse({
            graderId: "tests-pass",
            metric: "tests_pass",
            value: 0,
            pass: false,
            status: "unmeasured",
            reason: "grader_error",
            retryable: true,
          }),
        ]),
      ],
    };
    const diff = diffScorecards(base, cand);
    expect(diff.regressions).toEqual([]); // a dead grader is not a regression
    // The case-verdict transition says the same thing in the release unit: the candidate side produced no
    // verdict, so the shared case is "unmeasured" — never a broke.
    expect(diff.caseTransitions).toEqual([{ caseId: "a", baseline: true, change: "unmeasured" }]);
  });

  it("a case with a classified failure never enters the re-score worklist — its recovery is retry, not scoring", () => {
    // Regression: the dispatch placeholder (unmeasured, retryable) listed itself on the worklist, making the
    // rescore button an empty promise — rescore only re-runs judges, and a dead case has no trace to judge.
    const sc: Scorecard = {
      suiteId: "s",
      harness: "h@1",
      results: [
        {
          caseId: "dead",
          harness: "h@1",
          trace: [],
          snapshot: { kind: "prompt", output: "" },
          scores: [
            {
              graderId: "dispatch",
              metric: "error",
              status: "unmeasured",
              reason: "missing_evidence",
              retryable: true,
            },
          ],
          failure: { stage: "dispatch", class: "infra", code: "X", message: "m", retryable: true },
        },
      ],
    };
    expect(retryableUnmeasured(sc)).toEqual([]);
  });

  it("retryableUnmeasured lists exactly the transient failures as a re-score worklist", () => {
    const sc: Scorecard = {
      suiteId: "s",
      harness: "h@1",
      results: [
        result("a", [
          {
            graderId: "judge",
            metric: "judge:q",
            status: "unmeasured",
            reason: "grader_error",
            retryable: true,
          },
          {
            graderId: "j2",
            metric: "judge:r",
            status: "unmeasured",
            reason: "missing_secret",
            retryable: false,
          },
          measured("tests_pass", 1, true),
        ]),
      ],
    };
    expect(retryableUnmeasured(sc)).toEqual([{ caseId: "a", graderId: "judge", metric: "judge:q" }]);
  });
});

describe("diffScorecards — comparability first", () => {
  const one = (caseId: string, metric: string, value: number, pass?: boolean): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [{ graderId: metric, metric, value, ...(pass !== undefined ? { pass } : {}) }],
  });
  const cardOf = (results: CaseResult[]): Scorecard => ({ suiteId: "s", harness: "h@1", results });

  it("a metric missing on one side is enumerated, not zero-filled into the aggregate mean", () => {
    // Regression: the aggregate loop filled a one-sided metric's mean with ?? 0, so a vanished grader read
    // as a mean that crashed to zero — while the case-level loop silently skipped the same absence.
    const base = cardOf([one("a", "judge:quality", 0.9, true)]);
    const cand = cardOf([one("a", "tests_pass", 1, true)]);
    const diff = diffScorecards(base, cand);
    expect(diff.metrics).toEqual([]); // no shared metric → NO fabricated 0-mean rows
    expect(diff.missing.metricsOnlyInBaseline).toEqual(["judge:quality"]);
    expect(diff.missing.metricsOnlyInCandidate).toEqual(["tests_pass"]);
    expect(diff.comparability).toBe("none"); // no shared metrics — the comparison does not hold
  });

  it("one-sided cases are enumerated and downgrade comparability to partial", () => {
    const base = cardOf([one("a", "tests_pass", 1, true), one("gone", "tests_pass", 1, true)]);
    const cand = cardOf([one("a", "tests_pass", 0, false), one("new", "tests_pass", 1, true)]);
    const diff = diffScorecards(base, cand);
    expect(diff.missing.casesOnlyInBaseline).toEqual(["gone"]);
    expect(diff.missing.casesOnlyInCandidate).toEqual(["new"]);
    expect(diff.comparability).toBe("partial");
  });

  it("deltas are read through the declared direction — a cost increase is a regression, not an improvement", () => {
    const base = cardOf([one("a", "cost_usd", 0.1)]);
    const cand = cardOf([one("a", "cost_usd", 0.5)]);
    const m = diffScorecards(base, cand).metrics.find((x) => x.metric === "cost_usd");
    expect(m?.delta).toBeCloseTo(0.4);
    expect(m?.direction).toBe("lower_is_better");
    expect(m?.reading).toBe("regressed"); // delta > 0 but WORSE — sign alone must never be generalized
  });

  it("a metric with no declared direction reads unknown, never a sign guess", () => {
    const base = cardOf([one("a", "custom_metric", 1)]);
    const cand = cardOf([one("a", "custom_metric", 2)]);
    expect(diffScorecards(base, cand).metrics[0]?.reading).toBe("unknown");
  });

  it("trial results pair trial-to-trial — the last trial can no longer shadow the others (map last-wins)", () => {
    // Regression: scoreMap keyed by caseId alone, so on a trials>1 scorecard the LAST trial silently won and
    // a pass→fail transition in an earlier trial vanished from the case-level diff.
    const trialResult = (trial: number, pass: boolean): CaseResult => ({
      caseId: "a",
      harness: "h@1",
      trial,
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [{ graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass }],
    });
    const base = cardOf([trialResult(0, true), trialResult(1, true)]);
    const cand = cardOf([trialResult(0, false), trialResult(1, true)]); // trial 0 broke; trial 1 (the LAST) fine
    const diff = diffScorecards(base, cand);
    expect(diff.regressions).toHaveLength(1);
    expect(diff.regressions[0]?.caseId).toBe("a");
  });

  it("a metric whose value KIND changed between sides is incomparable, never a readable delta", () => {
    // Same name, different meaning: baseline scored "tier" numerically, candidate categorically (labels).
    const numeric = cardOf([one("a", "tier", 0.8, undefined)]);
    const categorical: Scorecard = {
      suiteId: "s",
      harness: "h@2",
      results: [
        {
          caseId: "a",
          harness: "h@2",
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tier", metric: "tier", value: 3, label: "gold" }],
        },
      ],
    };
    const diff = diffScorecards(numeric, categorical);
    expect(diff.incomparable).toEqual([{ metric: "tier", reason: "kind_changed" }]);
    expect(diff.metrics.find((m) => m.metric === "tier")).toBeUndefined(); // excluded, not a delta
    // The ONLY shared metric became incomparable — the comparison does not hold at all.
    expect(diff.comparability).toBe("none");
    expect(diff.overlap).toEqual({ sharedCases: 1, baselineCases: 1, candidateCases: 1 });
    // With another comparable metric alongside, the same kind change downgrades to partial instead.
    const numeric2 = cardOf([
      {
        ...numeric.results[0],
        scores: [...(numeric.results[0]?.scores ?? []), one("a", "cost_usd", 0.4).scores[0]],
      } as CaseResult,
    ]);
    const categorical2: Scorecard = {
      ...categorical,
      results: [
        {
          ...categorical.results[0],
          scores: [...(categorical.results[0]?.scores ?? []), one("a", "cost_usd", 0.5).scores[0]],
        } as CaseResult,
      ],
    };
    const diff2 = diffScorecards(numeric2, categorical2);
    expect(diff2.incomparable).toEqual([{ metric: "tier", reason: "kind_changed" }]);
    expect(diff2.comparability).toBe("partial");
  });

  it("identical full-overlap scorecards are fully comparable", () => {
    const base = cardOf([one("a", "tests_pass", 1, true)]);
    expect(diffScorecards(base, base).comparability).toBe("full");
    expect(diffScorecards(base, base).metrics[0]?.reading).toBe("unchanged");
  });
});

describe("diffScorecards", () => {
  it("catches regressions/improvements by pass transitions and produces metric deltas", () => {
    const base: Scorecard = {
      suiteId: "s1",
      harness: "h@1",
      results: [caseResult("a", "h@1", true, 2), caseResult("b", "h@1", false, 5)],
    };
    const cand: Scorecard = {
      suiteId: "s1",
      harness: "h@2",
      results: [caseResult("a", "h@2", false, 3), caseResult("b", "h@2", true, 4)],
    };
    const diff = diffScorecards(base, cand);
    expect(diff.regressions.map((d) => d.caseId)).toEqual(["a"]); // a: pass→fail
    expect(diff.improvements.map((d) => d.caseId)).toEqual(["b"]); // b: fail→pass
    // The case-verdict transitions agree here — the flipped metric IS the deciding rung on both cases.
    expect(diff.caseTransitions.find((t) => t.caseId === "a")?.change).toBe("broke");
    expect(diff.caseTransitions.find((t) => t.caseId === "b")?.change).toBe("fixed");
    const steps = diff.metrics.find((m) => m.metric === "tool_calls");
    expect(steps?.baselineMean).toBe(3.5);
    expect(steps?.candidateMean).toBe(3.5);
  });
});

describe("diffScorecards — the case-verdict transition is the release-regression unit", () => {
  const withScores = (caseId: string, scores: { metric: string; value: number; pass?: boolean }[]): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: scores.map((s) => ({ graderId: s.metric, ...s })),
  });
  const cardOf = (results: CaseResult[]): Scorecard => ({ suiteId: "s", harness: "h@1", results });

  it("a diagnostic judge flip on a case whose ground truth still passes is diagnosis, never a case transition", () => {
    // Given: tests_pass (ground truth) PASSES on both sides; judge:quality flips true → false.
    const base = cardOf([
      withScores("a", [
        { metric: "tests_pass", value: 1, pass: true },
        { metric: "judge:quality", value: 0.9, pass: true },
      ]),
    ]);
    const cand = cardOf([
      withScores("a", [
        { metric: "tests_pass", value: 1, pass: true },
        { metric: "judge:quality", value: 0.2, pass: false },
      ]),
    ]);
    const diff = diffScorecards(base, cand);
    // The metric flip is real and reported — as diagnosis.
    expect(diff.regressions.map((d) => d.metric)).toEqual(["judge:quality"]);
    // But the case VERDICT (authority-first: ground truth outranks the judge) did not move: PASS → PASS.
    expect(diff.caseTransitions).toEqual([{ caseId: "a", baseline: true, candidate: true, change: "same" }]);
  });

  it("one case losing several pass-bearing metrics is ONE broke transition", () => {
    const base = cardOf([
      withScores("a", [
        { metric: "tests_pass", value: 1, pass: true },
        { metric: "answer_match", value: 1, pass: true },
        { metric: "judge:quality", value: 0.9, pass: true },
      ]),
    ]);
    const cand = cardOf([
      withScores("a", [
        { metric: "tests_pass", value: 0, pass: false },
        { metric: "answer_match", value: 0, pass: false },
        { metric: "judge:quality", value: 0.1, pass: false },
      ]),
    ]);
    const diff = diffScorecards(base, cand);
    expect(diff.regressions).toHaveLength(3); // three metric flips — the WHY
    expect(diff.caseTransitions.filter((t) => t.change === "broke")).toHaveLength(1); // one case broke — the WHAT
  });

  it("a duplicated metric's diagnosis reads the verdict's unanimous algebra — never emission order", () => {
    // The candidate emits tests_pass TWICE: fail then pass. The verdict combines unanimously (fail); the
    // pre-fix diagnosis map kept the LAST row (pass), so the metric-level regressions list showed nothing
    // while caseTransitions said the case broke — the diagnosis contradicted the verdict it explains.
    const base = cardOf([withScores("a", [{ metric: "tests_pass", value: 1, pass: true }])]);
    const cand = cardOf([
      withScores("a", [
        { metric: "tests_pass", value: 0, pass: false },
        { metric: "tests_pass", value: 1, pass: true },
      ]),
    ]);
    const diff = diffScorecards(base, cand);
    expect(diff.caseTransitions).toEqual([{ caseId: "a", baseline: true, candidate: false, change: "broke" }]);
    expect(diff.regressions.map((d) => d.metric)).toEqual(["tests_pass"]); // the WHY agrees with the WHAT
    expect(diff.regressions[0]?.candidate).toBe(0); // …and carries the DECIDING (failing) row's value
  });

  it("an unresolvable side produces NO transitions — unknown policy means unknown verdict, not a re-judgment", () => {
    // Given a pair whose case would read as "broke" under any ladder — but the baseline's stamped policy
    // could not be restored. Pre-fix, `?? policy` re-judged the baseline under the candidate's (or default)
    // ladder and minted the broke transition anyway; those numbers then leaked into persisted gate evidence.
    const base = cardOf([withScores("a", [{ metric: "tests_pass", value: 1, pass: true }])]);
    const cand = cardOf([withScores("a", [{ metric: "tests_pass", value: 0, pass: false }])]);
    const diff = diffScorecards(base, cand, { baselinePolicy: "unresolvable" });
    expect(diff.caseTransitions).toEqual([]);
    expect(diff.transitionsUnavailable).toBe("baseline");
    const both = diffScorecards(base, cand, { baselinePolicy: "unresolvable", candidatePolicy: "unresolvable" });
    expect(both.transitionsUnavailable).toBe("both");
    // And a resolved pair is untouched by the new plumbing.
    const resolved = diffScorecards(base, cand);
    expect(resolved.transitionsUnavailable).toBeUndefined();
    expect(resolved.caseTransitions.filter((t) => t.change === "broke")).toHaveLength(1);
  });

  it("each side's verdict is derived under ITS OWN policy — the transition compares what each batch claimed", () => {
    const base = cardOf([withScores("a", [{ metric: "custom_gate", value: 1, pass: true }])]);
    const cand = cardOf([withScores("a", [{ metric: "custom_gate", value: 0, pass: false }])]);
    // Under the default ladder the undeclared metric decides via fallback: true → false = broke.
    expect(diffScorecards(base, cand).caseTransitions[0]?.change).toBe("broke");
    // Under a fallback-less policy neither side produces a verdict — the transition is honest about it.
    const noFallback = { ...DEFAULT_VERDICT_POLICY, fallback: "none" as const };
    const diff = diffScorecards(base, cand, { baselinePolicy: noFallback, candidatePolicy: noFallback });
    expect(diff.caseTransitions[0]?.change).toBe("unmeasured");
  });

  it("transitions pair trial-to-trial, the same keying as the metric-level diff", () => {
    const trialResult = (trial: number, pass: boolean): CaseResult => ({
      ...withScores("a", [{ metric: "tests_pass", value: pass ? 1 : 0, pass }]),
      trial,
    });
    const base = cardOf([trialResult(0, true), trialResult(1, true)]);
    const cand = cardOf([trialResult(0, false), trialResult(1, true)]);
    const transitions = diffScorecards(base, cand).caseTransitions;
    expect(transitions).toHaveLength(2);
    expect(transitions.find((t) => t.trial === 0)?.change).toBe("broke");
    expect(transitions.find((t) => t.trial === 1)?.change).toBe("same");
  });
});

describe("caseVerdict (authority-based)", () => {
  const sc = (scores: { metric: string; pass?: boolean; value?: number }[]): { scores: never } =>
    ({
      scores: scores.map((s) => ({ graderId: s.metric, metric: s.metric, value: s.value ?? 0, pass: s.pass })),
    }) as never;

  it("ground-truth (state) beats the judge — OSWorld file save: state PASS + judge FAIL → PASS", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "state", pass: true },
          { metric: "judge", pass: false },
        ]),
      ),
    ).toBe(true);
  });
  it("objective (answer_match) takes precedence over the judge", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "answer_match", pass: false },
          { metric: "judge", pass: true },
        ]),
      ),
    ).toBe(false);
  });
  it("with multiple objective graders, all must pass", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "url_matches", pass: true },
          { metric: "dom_contains", pass: false },
        ]),
      ),
    ).toBe(false);
  });
  it("with no objective/ground-truth, the judge decides", () => {
    expect(caseVerdict(sc([{ metric: "judge", pass: true }, { metric: "tool_calls" }]))).toBe(true);
  });
  it("a real judge:<id> metric decides on the judge rung, not the all-scores fallback", () => {
    // Regression: the judge rung matched the literal "judge" while JudgeGrader emits `judge:<id>`, so every
    // real judge verdict fell through to the fallback, where an unrelated pass-bearing score could veto it.
    expect(
      caseVerdict(
        sc([
          { metric: "judge:relevance", pass: true },
          { metric: "custom_check", pass: false }, // unranked observational score must not veto the judge
        ]),
      ),
    ).toBe(true);
  });
  it("multi-criteria sub-scores (judge:<id>:<criterion>) are diagnostic and never decide the case", () => {
    // The weighted overall (judge:<id>) is the judge's verdict; a failing criterion only localizes why.
    expect(
      caseVerdict(
        sc([
          { metric: "judge:quality", pass: true },
          { metric: "judge:quality:helpfulness", pass: false },
          { metric: "judge:quality:milestone:login", pass: false },
        ]),
      ),
    ).toBe(true);
  });
  it("criterion sub-scores stay diagnostic even when the top-level judge verdict is ABSENT", () => {
    // Regression: the old fixture always carried judge:quality, so the judge rung decided and the criterion
    // path was never actually exercised — with the top-level metric gone (judge died mid-emit, partial
    // ingest), 3-segment metrics matched nothing and fell into the undeclared FALLBACK, deciding the case.
    expect(
      caseVerdict(
        sc([
          { metric: "judge:quality:helpfulness", pass: false },
          { metric: "judge:quality:milestone:login", pass: false },
        ]),
      ),
    ).toBeUndefined();
  });
  it("with multiple judges and no policy, the verdict is the explicit unanimous vote over judges only", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "judge:a", pass: true },
          { metric: "judge:b", pass: false },
        ]),
      ),
    ).toBe(false);
  });
  it("an objective grader still overrules a real judge:<id>", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "answer_match", pass: false },
          { metric: "judge:quality", pass: true },
        ]),
      ),
    ).toBe(false);
  });
  it("undefined when there is no pass-deciding grader", () => {
    expect(caseVerdict(sc([{ metric: "tool_calls", value: 5 }]))).toBeUndefined();
  });
  it("scorecardPassRate: authority-based case pass rate", () => {
    const card: Scorecard = {
      suiteId: "s",
      harness: "h",
      results: [
        caseResult("a", "h", true, 3), // tests_pass PASS → PASS
        {
          ...caseResult("b", "h", true, 3),
          scores: [
            { graderId: "state", metric: "state", value: 1, pass: true },
            { graderId: "judge", metric: "judge", value: 0, pass: false },
          ],
        }, // state PASS / judge FAIL → PASS
      ],
    };
    expect(scorecardPassRate(card)).toEqual({ pass: 2, total: 2, rate: 1 });
  });
});

// C10 (review §6): "the grader reported unmeasured" and "the grader never emitted a row" are different
// failures — the second was invisible to both the metric SETS (one surviving row keeps the metric "shared")
// and measurementCoverage (an unemitted row is in no denominator).
describe("metricCoverage — silent grader omission becomes visible", () => {
  const rowOf = (caseId: string, metrics: string[]): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: metrics.map((m) => ({ graderId: m, metric: m, value: 1, pass: true })),
  });
  const cardOf = (results: CaseResult[]): Scorecard => ({ suiteId: "s", harness: "h@1", results });

  it("counts measured rows per metric per side — 100/100 vs 1/100 is no longer 'present on both sides'", () => {
    const ids = Array.from({ length: 3 }, (_, i) => `c${i}`);
    const baseline = cardOf(ids.map((id) => rowOf(id, ["tests_pass"])));
    // The candidate ran every case but the grader emitted a row on only ONE of them.
    const candidate = cardOf(ids.map((id, i) => rowOf(id, i === 0 ? ["tests_pass"] : [])));
    const coverage = metricCoverage(baseline, candidate);
    expect(coverage).toEqual([
      { metric: "tests_pass", baselineCases: 3, baselineMeasured: 3, candidateCases: 3, candidateMeasured: 1 },
    ]);
    // The diff carries it and downgrades comparability — no case is missing, yet the comparison is partial.
    const diff = diffScorecards(baseline, candidate);
    expect(diff.missing.casesOnlyInBaseline).toEqual([]);
    expect(diff.missing.metricsOnlyInBaseline).toEqual([]); // the SET comparison still says "shared"
    expect(diff.comparability).toBe("partial"); // …but the coverage asymmetry says otherwise
  });

  it("symmetric full coverage stays fully comparable — the check bites only on asymmetry", () => {
    const baseline = cardOf([rowOf("a", ["tests_pass"]), rowOf("b", ["tests_pass"])]);
    const diff = diffScorecards(baseline, baseline);
    expect(diff.metricCoverage[0]).toMatchObject({ baselineMeasured: 2, candidateMeasured: 2 });
    expect(diff.comparability).toBe("full");
  });
});
