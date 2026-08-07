import type { CaseResult, Score, Scorecard } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  caseVerdict,
  diffScorecards,
  retryableUnmeasured,
  scorecardPassRate,
  summarizeScorecard,
} from "./scorecard.js";

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
            value: 0,
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
    // Rows persisted before the status field marked the two skip producers in detail prose only.
    const sc: Scorecard = {
      suiteId: "s",
      harness: "h@1",
      results: [
        result("a", [measured("judge:quality", 0.9, true)]),
        result("b", [{ graderId: "judge", metric: "judge:quality", value: 0, detail: "[grader-error] 503" }]),
        result("c", [{ graderId: "q", metric: "judge:quality", value: 0, detail: "skipped: no ANTHROPIC_API_KEY" }]),
      ],
    };
    const m = summarizeScorecard(sc).find((s) => s.metric === "judge:quality");
    expect(m?.mean).toBe(0.9);
    expect(m?.count).toBe(1);
    expect(m?.unmeasured).toBe(2);
  });

  it("an unmeasured score cannot decide a case verdict even if it carries a pass flag", () => {
    expect(
      caseVerdict({
        scores: [
          { graderId: "j", metric: "judge:q", value: 0, pass: false, status: "unmeasured", reason: "grader_error" },
          { graderId: "custom", metric: "custom_check", value: 1, pass: true },
        ],
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
          {
            graderId: "tests-pass",
            metric: "tests_pass",
            value: 0,
            pass: false,
            status: "unmeasured",
            reason: "grader_error",
          },
        ]),
      ],
    };
    const diff = diffScorecards(base, cand);
    expect(diff.regressions).toEqual([]); // a dead grader is not a regression
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
            value: 0,
            status: "unmeasured",
            reason: "grader_error",
            retryable: true,
          },
          {
            graderId: "j2",
            metric: "judge:r",
            value: 0,
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
    expect(diff.comparability).toBe("partial");
    expect(diff.overlap).toEqual({ sharedCases: 1, baselineCases: 1, candidateCases: 1 });
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
    const steps = diff.metrics.find((m) => m.metric === "tool_calls");
    expect(steps?.baselineMean).toBe(3.5);
    expect(steps?.candidateMean).toBe(3.5);
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
