import type { CaseResult, Scorecard } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { caseVerdict, diffScorecards, scorecardPassRate, summarizeScorecard } from "./scorecard.js";

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
