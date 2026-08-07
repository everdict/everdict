import { BadRequestError, type CaseResult, type Scorecard, type VerdictPolicy } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { caseTrialStats, diffTrials, groupTrials, passAtK, summarizeTrials } from "./trials.js";
import { DEFAULT_VERDICT_POLICY } from "./verdict-policy.js";

// One trial (a CaseResult) with a tests_pass verdict. trialIdx is optional (absent = single-run).
function trial(caseId: string, pass: boolean, trialIdx?: number): CaseResult {
  return {
    caseId,
    harness: "h@1",
    ...(trialIdx !== undefined ? { trial: trialIdx } : {}),
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [{ graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass }],
  };
}

// N trials of a case, `passes` of them passing (the first `passes` pass, the rest fail).
function trials(caseId: string, passes: number, n: number): CaseResult[] {
  return Array.from({ length: n }, (_, i) => trial(caseId, i < passes, i));
}

// A trial whose graders decide nothing (no pass field) — excluded from trial stats.
function undecided(caseId: string): CaseResult {
  return {
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [{ graderId: "steps", metric: "tool_calls", value: 5 }],
  };
}

const card = (harness: string, results: CaseResult[]): Scorecard => ({ suiteId: "s", harness, results });

describe("passAtK", () => {
  it("pass@1 equals the observed pass rate c/n", () => {
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4, 10);
    expect(passAtK(4, 3, 1)).toBeCloseTo(0.75, 10);
  });

  it("is 0 when nothing passed and 1 when everything passed, for any k", () => {
    expect(passAtK(5, 0, 3)).toBe(0);
    expect(passAtK(5, 5, 3)).toBe(1);
  });

  it("matches the unbiased 1 - C(n-c,k)/C(n,k) estimator on a known case", () => {
    // n=4, c=1, k=2 → 1 - C(3,2)/C(4,2) = 1 - 3/6 = 0.5
    expect(passAtK(4, 1, 2)).toBeCloseTo(0.5, 10);
  });

  it("clamps k>n to pass@n (undefined otherwise) — one pass in 3 trials, pass@10 → 1", () => {
    expect(passAtK(3, 1, 10)).toBe(1);
  });

  it("rejects invalid inputs (n<=0, c out of range, k<=0, non-integers)", () => {
    expect(() => passAtK(0, 0, 1)).toThrow(BadRequestError);
    expect(() => passAtK(5, 6, 1)).toThrow(BadRequestError);
    expect(() => passAtK(5, -1, 1)).toThrow(BadRequestError);
    expect(() => passAtK(5, 2, 0)).toThrow(BadRequestError);
    expect(() => passAtK(5.5, 2, 1)).toThrow(BadRequestError);
  });
});

describe("groupTrials", () => {
  it("buckets results by caseId, preserving insertion order", () => {
    const sc = card("h@1", [trial("a", true, 0), trial("b", false, 0), trial("a", false, 1)]);
    const groups = groupTrials(sc);
    expect([...groups.keys()]).toEqual(["a", "b"]);
    expect(groups.get("a")?.map((r) => r.trial)).toEqual([0, 1]);
  });
});

describe("caseTrialStats", () => {
  it("counts passes across trials and flags a mixed-outcome case as flaky", () => {
    const s = caseTrialStats("a", trials("a", 2, 5));
    expect(s).toEqual({ caseId: "a", trials: 5, passes: 2, passRate: 0.4, flaky: true });
  });

  it("an all-pass or all-fail case is not flaky", () => {
    expect(caseTrialStats("a", trials("a", 5, 5)).flaky).toBe(false);
    expect(caseTrialStats("a", trials("a", 0, 5)).flaky).toBe(false);
  });

  it("excludes trials that have no pass-deciding grader (same rule as scorecardPassRate)", () => {
    const s = caseTrialStats("a", [trial("a", true, 0), undecided("a"), trial("a", false, 1)]);
    expect(s.trials).toBe(2); // the undecided trial is not counted
    expect(s.passes).toBe(1);
  });
});

describe("summarizeTrials", () => {
  it("weights each case once — passAt1 is the mean of per-case pass rates, not per-trial", () => {
    // case a: 3/3 = 1.0, case b: 0/9 = 0.0. Uneven trial counts expose case-weighting vs trial-weighting.
    const sc = card("h@1", [...trials("a", 3, 3), ...trials("b", 0, 9)]);
    const sum = summarizeTrials(sc);
    // per-case: a=1.0, b=0.0 → mean 0.5. A per-trial mean would be 3/12 = 0.25, proving case-weighting.
    expect(sum.passAt1).toBeCloseTo(0.5, 10);
    expect(sum.cases).toBe(2);
    expect(sum.minTrials).toBe(3);
    expect(sum.maxTrials).toBe(9);
  });

  it("defaults k to maxTrials and reports pass@k as the mean over cases", () => {
    // Two cases, 5 trials each: a=3/5, b=0/5. pass@5 (any of 5): a→1, b→0 → mean 0.5.
    const sc = card("h@1", [...trials("a", 3, 5), ...trials("b", 0, 5)]);
    const sum = summarizeTrials(sc);
    expect(sum.k).toBe(5);
    expect(sum.passAtK).toBeCloseTo(0.5, 10);
  });

  it("counts flaky cases and reports the flake rate", () => {
    const sc = card("h@1", [...trials("a", 2, 5), ...trials("b", 5, 5), ...trials("c", 0, 5)]);
    const sum = summarizeTrials(sc);
    expect(sum.flakyCases).toBe(1); // only a is mixed
    expect(sum.flakeRate).toBeCloseTo(1 / 3, 10);
  });

  it("returns zeros for a scorecard with no scored trials", () => {
    const sum = summarizeTrials(card("h@1", [undecided("a")]));
    expect(sum).toMatchObject({ cases: 0, passAt1: 0, passAtK: 0, flakeRate: 0 });
  });
});

describe("diffTrials (statistical regression gate)", () => {
  it("does NOT flag a within-noise pass-rate drop as a regression (3/5 → 2/5)", () => {
    const base = card("h@1", trials("a", 3, 5));
    const cand = card("h@2", trials("a", 2, 5));
    const diff = diffTrials(base, cand);
    const a = diff.cases.find((d) => d.caseId === "a");
    expect(a?.delta).toBeCloseTo(-0.2, 10);
    expect(a?.significant).toBe(false); // |z|≈0.63 < 1.96 — this is the whole point of trials
    expect(diff.regressions).toEqual([]);
  });

  it("flags a significant pass-rate collapse as a regression (5/5 → 0/5)", () => {
    const base = card("h@1", trials("a", 5, 5));
    const cand = card("h@2", trials("a", 0, 5));
    const diff = diffTrials(base, cand);
    expect(diff.regressions.map((d) => d.caseId)).toEqual(["a"]);
    expect(diff.regressions[0]?.z).toBeLessThanOrEqual(-1.96);
  });

  it("flags a significant pass-rate jump as an improvement (0/5 → 5/5)", () => {
    const base = card("h@1", trials("a", 0, 5));
    const cand = card("h@2", trials("a", 5, 5));
    const diff = diffTrials(base, cand);
    expect(diff.improvements.map((d) => d.caseId)).toEqual(["a"]);
    expect(diff.regressions).toEqual([]);
  });

  it("skips cases missing on one side or with no scored trials", () => {
    const base = card("h@1", [...trials("a", 5, 5), ...trials("b", 5, 5)]);
    const cand = card("h@2", [...trials("a", 0, 5), undecided("b")]); // c only present as undecided
    const diff = diffTrials(base, cand);
    expect(diff.cases.map((d) => d.caseId)).toEqual(["a"]); // b skipped (0 scored candidate trials)
  });

  it("small samples gate by Fisher's exact test — the z approximation's overconfidence is gone", () => {
    // 5/5 → 2/5: z ≈ -2.07 LOOKED significant at 95%, but the exact two-sided p is ~0.167 — at n=5 the
    // honest answer is "not enough evidence", and the gate now says so instead of pretending.
    const base = card("h@1", trials("a", 5, 5));
    const cand = card("h@2", trials("a", 2, 5));
    const d = diffTrials(base, cand, { zThreshold: 1.96 });
    expect(d.cases[0]?.method).toBe("fisher");
    expect(d.cases[0]?.p).toBeCloseTo(1 / 6, 3);
    expect(d.regressions).toHaveLength(0);
    // 5/5 → 0/5 IS exact-significant (p ≈ 0.0079): a real crash on five trials still trips the gate.
    const crashed = card("h@2", trials("a", 0, 5));
    const d2 = diffTrials(base, crashed, { zThreshold: 1.96 });
    expect(d2.cases[0]?.p).toBeCloseTo(2 / 252, 4);
    expect(d2.regressions).toHaveLength(1);
    // ...and a stricter confidence (z 3.29 ≈ 99.9%) still filters it.
    expect(diffTrials(base, crashed, { zThreshold: 3.29 }).regressions).toHaveLength(0);
  });

  it("the practical threshold keeps a statistically-significant-but-negligible drop out of the gate", () => {
    // 500 trials each, 100% → 96%: z ≈ -4.5 (highly significant) — but a 4% dip below the declared 5%
    // practical floor is noise to this gate, not a regression.
    const base = card("h@1", trials("a", 500, 500));
    const cand = card("h@2", trials("a", 480, 500));
    expect(diffTrials(base, cand).cases[0]?.method).toBe("z");
    expect(diffTrials(base, cand).regressions).toHaveLength(1); // minDelta 0 (default): gated by stats alone
    expect(diffTrials(base, cand, { minDelta: 0.05 }).regressions).toHaveLength(0);
  });

  it("judges each side's trials under ITS OWN policy — a historical batch is never re-judged by today's ladder", () => {
    // Given trials whose only pass-deciding measurement is a CUSTOM metric the default ladder does not declare.
    // Under the default it reaches the fallback rung and decides; under a policy that marks it `excluded` it
    // decides nothing at all, so the case has no scored trials.
    const custom = (caseId: string, pass: boolean, i: number): CaseResult => ({
      caseId,
      harness: "h@1",
      trial: i,
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [{ graderId: "schema", metric: "schema_valid", value: pass ? 1 : 0, pass }],
    });
    const base = card(
      "h@1",
      [0, 1, 2].map((i) => custom("a", true, i)),
    );
    const cand = card(
      "h@2",
      [0, 1, 2].map((i) => custom("a", false, i)),
    );
    const excludes: VerdictPolicy = {
      ...DEFAULT_VERDICT_POLICY,
      metrics: [{ match: { metric: "schema_valid" }, authority: "objective", verdictRole: "excluded" }],
      fallback: "none",
    };
    // Both sides under the default ladder: 3/3 → 0/3, a real (if small-n) comparison.
    expect(diffTrials(base, cand).cases[0]).toMatchObject({ baselineRate: 1, candidateRate: 0 });
    // The candidate's OWN policy excludes the metric — it has no scored trials, so it cannot enter the gate.
    // Pre-fix, diffTrials always read the default ladder and manufactured a 3/3 → 0/3 comparison out of a
    // batch that never had a verdict.
    const d = diffTrials(base, cand, { candidatePolicy: excludes });
    expect(d.cases).toEqual([]);
    expect(d.missing.unscoredCases).toEqual(["a"]);
  });

  it("reports what could not enter the gate instead of silently dropping it", () => {
    const base = card("h@1", [...trials("a", 3, 3), ...trials("gone", 3, 3), ...trials("u", 3, 3)]);
    const cand = card("h@2", [...trials("a", 3, 3), ...trials("new", 3, 3), undecided("u")]);
    const d = diffTrials(base, cand);
    expect(d.missing.casesOnlyInBaseline).toEqual(["gone"]);
    expect(d.missing.casesOnlyInCandidate).toEqual(["new"]);
    expect(d.missing.unscoredCases).toEqual(["u"]); // present on both sides, but no scored candidate trials
    expect(d.cases.map((c) => c.caseId)).toEqual(["a"]);
  });
});
