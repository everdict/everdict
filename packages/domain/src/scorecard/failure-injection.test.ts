import type { CaseFailure, CaseResult, Score, Scorecard } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { scorecardOutcomes } from "./case-outcome.js";
import { diffScorecards, scorecardPassRate, summarizeScorecard } from "./scorecard.js";
import { evaluateVerdict } from "./verdict-policy.js";

// ── The canonical failure-injection suite (trust-kernel P6) ─────────────────────────────────────────────
// One invariant, stated as the core proposition of the kernel:
//
//   NO FAILURE EVER CONVERTS INTO A NORMAL NUMBER OR A NORMAL PRODUCT VERDICT.
//
// A "monster" scorecard carries every injection at once — a grader error, a judge skip, a legacy error
// sentinel, a dispatch death, a duplicate metric, a judge contradicting ground truth — on top of a clean
// core. Every aggregate of the monster must equal the clean control bit-for-bit, and each injection must be
// visible ONLY in its designated channel (unmeasured tally / infraFailed / missing / basis). When a new
// failure mode is discovered, it is ADDED HERE first — the suite is append-only, like the injections it pins.

const snapshot = { kind: "repo", diff: "", changedFiles: [], headSha: "h" } as const;
const result = (caseId: string, scores: Score[], failure?: CaseFailure): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { ...snapshot, changedFiles: [] },
  scores,
  ...(failure ? { failure } : {}),
});
const s = (metric: string, value: number, pass?: boolean): Score => ({
  graderId: metric,
  metric,
  value,
  ...(pass !== undefined ? { pass } : {}),
});
const dispatchDeath: CaseFailure = {
  stage: "dispatch",
  class: "infra",
  code: "UPSTREAM_ERROR",
  message: "node drained",
  retryable: true,
};

// The clean core: two decided cases (one pass, one fail) with a cost metric.
const CLEAN: Scorecard = {
  suiteId: "s",
  harness: "h@1",
  results: [
    result("ok", [s("tests_pass", 1, true), s("cost_usd", 0.5)]),
    result("bad", [s("tests_pass", 0, false), s("cost_usd", 0.7)]),
  ],
};

// The same core with every injection added.
const MONSTER: Scorecard = {
  ...CLEAN,
  results: [
    ...CLEAN.results,
    // ① grader threw at scoring time (safeGrade shape)
    result("grader-died", [
      {
        graderId: "cost",
        metric: "cost_usd",
        value: 0,
        status: "unmeasured",
        reason: "grader_error",
        retryable: true,
        detail: "[grader-error] judge upstream 503",
      },
    ]),
    // ② judge skipped (no secret) — judge-runner skip shape
    result("judge-skipped", [
      {
        graderId: "quality",
        metric: "judge:quality",
        value: 0,
        status: "unmeasured",
        reason: "missing_secret",
        retryable: false,
        detail: "skipped: ANTHROPIC_API_KEY secret not configured",
      },
    ]),
    // ③ a legacy pre-status row (persisted before the field existed)
    result("legacy-sentinel", [{ graderId: "judge", metric: "judge:quality", value: 0, detail: "[grader-error] 503" }]),
    // ④ dispatch death (failedCaseResult shape) — hostile twist: a stray pass:false diagnostic
    {
      ...result(
        "dispatch-died",
        [
          {
            graderId: "dispatch",
            metric: "error",
            value: 0,
            status: "unmeasured",
            reason: "missing_evidence",
            retryable: true,
            detail: "[infra] node drained",
          },
        ],
        dispatchDeath,
      ),
      snapshot: { kind: "prompt", output: "" },
    },
  ],
};

describe("failure injection — no failure converts into a normal number or product verdict", () => {
  it("every metric aggregate of the monster equals the clean control bit-for-bit", () => {
    const clean = summarizeScorecard(CLEAN);
    const monster = summarizeScorecard(MONSTER);
    for (const metric of ["tests_pass", "cost_usd"]) {
      const c = clean.find((m) => m.metric === metric);
      const m = monster.find((x) => x.metric === metric);
      expect(m?.mean).toBe(c?.mean);
      expect(m?.count).toBe(c?.count);
      expect(m?.passRate).toBe(c?.passRate);
    }
  });

  it("the product pass rate is identical — the injections live only in their designated channels", () => {
    expect(scorecardPassRate(MONSTER)).toEqual(scorecardPassRate(CLEAN));
    const outcomes = scorecardOutcomes(MONSTER);
    expect(outcomes).toEqual({
      executed: 6,
      gradeable: 5,
      verdicted: 2, // exactly the clean core
      passed: 1,
      failed: 1,
      infraFailed: 1, // the dispatch death
      unmeasured: 3, // grader error + judge skip + legacy sentinel — visible, never counted
    });
    const monsterSummary = summarizeScorecard(MONSTER);
    expect(monsterSummary.find((m) => m.metric === "judge:quality")?.unmeasured).toBe(2);
    expect(monsterSummary.find((m) => m.metric === "cost_usd")?.unmeasured).toBe(1);
  });

  it("diffing monster against clean reports the injected cases as missing — never as regressions", () => {
    const diff = diffScorecards(CLEAN, MONSTER);
    expect(diff.regressions).toEqual([]);
    expect(diff.improvements).toEqual([]);
    expect(diff.missing.casesOnlyInCandidate.sort()).toEqual([
      "dispatch-died",
      "grader-died",
      "judge-skipped",
      "legacy-sentinel",
    ]);
    expect(diff.comparability).toBe("partial"); // and the diff SAYS the comparison is partial
    // the shared metrics still compare cleanly — unmeasured placeholders contributed nothing
    expect(diff.metrics.find((m) => m.metric === "cost_usd")?.delta).toBe(0);
  });

  it("a judge contradicting ground truth loses, and the verdict names its winning basis", () => {
    const conflicted = result("conflict", [s("state", 1, true), s("judge:vlm", 0, false)]);
    const { verdict, basis } = evaluateVerdict(conflicted);
    expect(verdict).toBe(true);
    expect(basis?.authority).toBe("ground_truth");
    expect(basis?.deciders).toEqual([{ metric: "state", graderId: "state", pass: true }]);
  });

  it("a duplicate metric with conflicting votes can never sneak a pass through emission order", () => {
    for (const scores of [
      [s("tests_pass", 0, false), s("tests_pass", 1, true)],
      [s("tests_pass", 1, true), s("tests_pass", 0, false)],
    ]) {
      expect(evaluateVerdict({ scores }).verdict).toBe(false);
    }
  });

  it("an INVALID score (grader contract violation) is out of every aggregate and every retry worklist", () => {
    const invalid: Score = {
      graderId: "buggy",
      metric: "quality",
      value: 0,
      status: "invalid",
      reason: "contract_violation",
      retryable: false,
      detail: "[invalid-score] value=NaN",
    };
    const sc: Scorecard = { suiteId: "s", harness: "h@1", results: [result("x", [invalid])] };
    expect(summarizeScorecard(sc).find((m) => m.metric === "quality")?.count).toBe(0);
    expect(summarizeScorecard(sc).find((m) => m.metric === "quality")?.unmeasured).toBe(1); // visible
    expect(evaluateVerdict({ scores: [invalid] })).toEqual({}); // never decides
  });

  it("a REAL measurement whose prose detail merely opens like a sentinel is NOT misclassified", () => {
    // The legacy-sentinel normalization requires pass === undefined too — both legacy producers left it unset.
    const m: Score = {
      graderId: "custom",
      metric: "custom_check",
      value: 1,
      pass: true,
      detail: "[grader-error] is the exact string this check searched for",
    };
    const sc: Scorecard = { suiteId: "s", harness: "h@1", results: [result("x", [m])] };
    expect(summarizeScorecard(sc).find((x) => x.metric === "custom_check")?.count).toBe(1); // measured
  });

  it("a hostile unmeasured score carrying pass flags cannot decide, veto, or shift anything", () => {
    const hostile: Score = {
      graderId: "evil",
      metric: "tests_pass",
      value: 1,
      pass: true,
      status: "unmeasured",
      reason: "grader_error",
    };
    // alone: nothing decides
    expect(evaluateVerdict({ scores: [hostile] })).toEqual({});
    // beside a real FAIL measurement: the real one decides
    expect(evaluateVerdict({ scores: [hostile, s("tests_pass", 0, false)] }).verdict).toBe(false);
    // and it never enters the mean
    const sc: Scorecard = { suiteId: "s", harness: "h@1", results: [result("x", [hostile])] };
    expect(summarizeScorecard(sc).find((m) => m.metric === "tests_pass")?.count).toBe(0);
  });
});
