import type { CaseFailure, CaseResult, Score, Scorecard } from "@everdict/contracts";
import { ScoreSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { scorecardOutcomes } from "./case-outcome.js";
import { headlinePassRate } from "./headline.js";
import { leaderboard } from "./leaderboard.js";
import { diffScorecards, scorecardPassRate, summarizeScorecard } from "./scorecard.js";
import { trendSeries } from "./trend.js";
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
        status: "unmeasured",
        reason: "missing_secret",
        retryable: false,
        detail: "skipped: ANTHROPIC_API_KEY secret not configured",
      },
    ]),
    // ③ a legacy pre-status row (persisted before the field existed)
    // A legacy row only ever exists as DATA — legacy tolerance lives in the decoder, so it enters through it.
    result("legacy-sentinel", [
      ScoreSchema.parse({ graderId: "judge", metric: "judge:quality", value: 0, detail: "[grader-error] 503" }),
    ]),
    // ④ dispatch death (failedCaseResult shape)
    {
      ...result(
        "dispatch-died",
        [
          {
            graderId: "dispatch",
            metric: "error",
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
    // ⑤ cancelled mid-run WITH a surviving MEASURED pass — the hostile half of cancellation: partial work
    // under a kill left a real-looking measurement behind, and an outcome-blind aggregator would fold it in.
    result("cancelled-mid-run", [s("tests_pass", 1, true), s("cost_usd", 0.1)], {
      stage: "run",
      class: "infra",
      code: "CANCELLED",
      message: "batch stopped by the user",
      retryable: false,
    }),
  ],
};

describe("failure injection — no failure converts into a normal number or product verdict", () => {
  it("every metric aggregate of the monster equals the clean control bit-for-bit", () => {
    const clean = summarizeScorecard(CLEAN);
    const monster = summarizeScorecard(MONSTER);
    // The CONTROL's values are pinned as concrete numbers first — `expect(m?.mean).toBe(c?.mean)` alone is
    // vacuously green when the aggregator stops emitting the metric (undefined === undefined), which would
    // have let a totally broken summarize pass the suite's flagship assertion.
    expect(clean.find((m) => m.metric === "tests_pass")).toMatchObject({ count: 2, mean: 0.5, passRate: 0.5 });
    expect(clean.find((m) => m.metric === "cost_usd")).toMatchObject({ count: 2, mean: 0.6 });
    for (const metric of ["tests_pass", "cost_usd"]) {
      const c = clean.find((m) => m.metric === metric);
      const m = monster.find((x) => x.metric === metric);
      expect(c).toBeDefined();
      expect(m?.mean).toBe(c?.mean);
      expect(m?.count).toBe(c?.count);
      expect(m?.passRate).toBe(c?.passRate);
    }
  });

  it("the product pass rate is identical — the injections live only in their designated channels", () => {
    expect(scorecardPassRate(MONSTER)).toEqual(scorecardPassRate(CLEAN));
    const outcomes = scorecardOutcomes(MONSTER);
    expect(outcomes).toEqual({
      executed: 7,
      gradeable: 5,
      verdicted: 2, // exactly the clean core
      passed: 1,
      failed: 1,
      infraFailed: 1, // the dispatch death
      cancelled: 1, // the mid-run kill — its own denominator, never a verdict
      unmeasured: 3, // grader error + judge skip + legacy sentinel — visible, never counted
    });
    const monsterSummary = summarizeScorecard(MONSTER);
    expect(monsterSummary.find((m) => m.metric === "judge:quality")?.unmeasured).toBe(2);
    expect(monsterSummary.find((m) => m.metric === "cost_usd")?.unmeasured).toBe(1);
  });

  it("a no-outcome case (cancelled / pre-outcome death) contributes NO summary row — its diagnostics live on the failure plane", () => {
    const monster = summarizeScorecard(MONSTER);
    // The dispatch death's diagnostic score used to materialize a poisoned {metric:"error", count:0} row that
    // every count-blind consumer read as a measured zero; the cancelled case's surviving pass:true would have
    // shifted tests_pass toward 2/3. Neither belongs to the metric plane at all.
    expect(monster.find((m) => m.metric === "error")).toBeUndefined();
    expect(monster.find((m) => m.metric === "tests_pass")?.count).toBe(2); // the clean core only
  });

  it("the reverse diff enumerates the injected cases as missing from the candidate side too", () => {
    const diff = diffScorecards(MONSTER, CLEAN);
    expect(diff.regressions).toEqual([]);
    expect(diff.improvements).toEqual([]);
    expect(diff.missing.casesOnlyInBaseline.sort()).toEqual([
      "cancelled-mid-run",
      "dispatch-died",
      "grader-died",
      "judge-skipped",
      "legacy-sentinel",
    ]);
    expect(diff.comparability).toBe("partial");
  });

  it("diffing monster against clean reports the injected cases as missing — never as regressions", () => {
    const diff = diffScorecards(CLEAN, MONSTER);
    expect(diff.regressions).toEqual([]);
    expect(diff.improvements).toEqual([]);
    expect(diff.missing.casesOnlyInCandidate.sort()).toEqual([
      "cancelled-mid-run",
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
      status: "invalid",
      reason: "contract_violation",
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
    // The measurement algebra makes this row unconstructible in TypeScript — an unmeasured score has no
    // `pass` and no `value` field at all. Hostile data arrives over a WIRE, though, so the row is built as
    // raw JSON and put through the decoder every boundary embeds: the normalizer strips the pass flag and
    // the placeholder value on the way in, and what reaches the engine can no longer pretend to be one.
    const hostile: Score = ScoreSchema.parse({
      graderId: "evil",
      metric: "tests_pass",
      value: 1,
      pass: true,
      status: "unmeasured",
      reason: "grader_error",
      retryable: true,
    });
    expect(hostile).toEqual({
      graderId: "evil",
      metric: "tests_pass",
      status: "unmeasured",
      reason: "grader_error",
      retryable: true,
    });
    // alone: nothing decides
    expect(evaluateVerdict({ scores: [hostile] })).toEqual({});
    // beside a real FAIL measurement: the real one decides
    expect(evaluateVerdict({ scores: [hostile, s("tests_pass", 0, false)] }).verdict).toBe(false);
    // and it never enters the mean
    const sc: Scorecard = { suiteId: "s", harness: "h@1", results: [result("x", [hostile])] };
    expect(summarizeScorecard(sc).find((m) => m.metric === "tests_pass")?.count).toBe(0);
  });
});

describe("failure injection — the summary plane (annihilated metrics never become numbers)", () => {
  // A batch whose metric was ENTIRELY unmeasured (the grader died on every case).
  const annihilated = (id: string, createdAt: string) => ({
    id,
    dataset: { id: "d", version: "1" },
    harness: { id: "dead-grader", version: "1" },
    status: "succeeded",
    createdAt,
    summary: summarizeScorecard({
      suiteId: "s",
      harness: "dead-grader@1",
      results: [
        result("a", [
          {
            graderId: "cost",
            metric: "cost_usd",
            status: "unmeasured" as const,
            reason: "grader_error" as const,
            retryable: true,
          },
        ]),
      ],
    }),
  });
  const healthy = (id: string, mean: number, createdAt: string) => ({
    id,
    dataset: { id: "d", version: "1" },
    harness: { id: "live", version: "1" },
    status: "succeeded",
    createdAt,
    summary: [{ metric: "cost_usd", count: 3, mean }],
  });

  it("an annihilated metric has NO mean — count 0, unmeasured tally only", () => {
    const row = annihilated("x", "2026-01-01T00:00:00Z").summary.find((m) => m.metric === "cost_usd");
    expect(row?.count).toBe(0);
    expect(row?.mean).toBeUndefined(); // a mean over nothing is not 0
    expect(row?.unmeasured).toBe(1);
  });

  it("a dead grader can never rank — let alone FIRST on a lower-is-better leaderboard", () => {
    const lb = leaderboard([healthy("a", 0.4, "2026-01-01T00:00:00Z"), annihilated("b", "2026-01-02T00:00:00Z")], {
      datasetId: "d",
      metric: "cost_usd",
    });
    expect(lb.rows[0]?.harness.id).toBe("live"); // pre-fix: dead-grader ranked #1 at mean 0
    expect(lb.rows.find((r) => r.harness.id === "dead-grader")?.score).toBeNull();
  });

  it("an outage is a GAP in the trend line, never a plunge to zero flagged as regression", () => {
    const t = trendSeries([healthy("a", 0.4, "2026-01-01T00:00:00Z"), annihilated("b", "2026-01-02T00:00:00Z")], {
      datasetId: "d",
      metric: "cost_usd",
    });
    expect(t.points[1]?.score).toBeNull();
    expect(t.points[1]?.regressed).toBe(false);
  });

  it("a batch whose every trial died never headlines as 0% — nothing pass-deciding is null", () => {
    expect(
      headlinePassRate({
        trialSummary: { cases: 0, passAt1: 0 }, // summarizeTrials' empty-stats shape
        summary: [],
      }),
    ).toBeNull();
  });
});
