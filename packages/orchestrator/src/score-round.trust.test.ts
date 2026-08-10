import type { CaseResult, Score } from "@everdict/contracts";
import {
  MAX_JUDGE_ATTEMPTS_PER_PASS,
  judgeAttemptsOf,
  judgePending,
  pendingJudgesFor,
  stampJudgeAttempts,
  stripJudgeScores,
} from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { MAX_STALLED_SCORE_ROUNDS, type ScoreRoundState, decideScoreRound } from "./score-round.js";

// Trust suite (docs/trust-certification.md) — TRUST-61.
//
// A RETRY BUDGET BELONGS TO THE JUDGMENT, NOT TO THE BATCH IT HAPPENS TO SIT IN.
//
// `MAX_JUDGE_ATTEMPTS_PER_PASS` says a retryable unmeasured judgment gets three goes inside one pass. That
// sentence was true of the domain and false of the system: the scoring workflow planned ONCE and then chose
// between finalize and rotate on whether the plan overflowed its slice, so a 601-case batch re-planned (and
// retried) while a 1-case batch finalized after a single attempt. The smallest possible group — one case, one
// judge — is the sharpest form of the claim, because there is no second case whose bulk can force a re-plan.
//
// It is certified over the REAL loop decision and the REAL attempt accounting; only the judge's verdict is
// faked, because "fails twice, then succeeds" is precisely the thing being stood up. The first draft of the
// stall guard failed this scenario — with a one-key worklist no round can shrink the plan until the very last
// one, so a bound of 2 abandoned the case one attempt before it would have succeeded. That is why the guard is
// derived from the retry budget rather than picked.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const JUDGES = [{ id: "grader", version: "1.0.0" }];
const KEY = "c1#0";

const caseResult = (scores: Score[]): CaseResult => ({
  caseId: "c1",
  harness: "h@1",
  trace: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores,
});

describeTrust("TRUST-61 — a one-case group really does spend its whole retry budget in one pass", () => {
  // The judge: `failures` retryable unmeasured verdicts, then a measured one. Everything around it — which
  // judges are pending, what the strip removes, how the attempt counter survives that strip — is production.
  function runPass(failures: number): { attempts: number; ending: string } {
    let result = caseResult([]);
    let attempts = 0;
    const judgeOnce = (): void => {
      const pending = pendingJudgesFor(result, JUDGES);
      if (pending.length === 0) return;
      const prior = judgeAttemptsOf(result, pending);
      const kept = stripJudgeScores(result.scores, pending);
      attempts += 1;
      const produced: Score[] =
        attempts <= failures
          ? [
              {
                graderId: "grader",
                metric: "judge:grader",
                status: "unmeasured",
                reason: "grader_error",
                retryable: true,
              },
            ]
          : [{ graderId: "grader", metric: "judge:grader", value: 1, pass: true }];
      result = caseResult(stampJudgeAttempts([...kept, ...produced], pending, prior));
    };

    let state: ScoreRoundState = { stalled: 0, round: 0 };
    for (;;) {
      // The planner's real predicate, over the real plane.
      const planned = judgePending(result, JUDGES) ? [KEY] : [];
      const decision = decideScoreRound(planned, state, false, 500);
      if (decision.kind !== "execute") return { attempts, ending: decision.kind };
      state = decision.state;
      judgeOnce();
    }
  }

  it("retryable × 2 then measured is executed THREE times and finishes clean", () => {
    expect(runPass(2)).toEqual({ attempts: MAX_JUDGE_ATTEMPTS_PER_PASS, ending: "finish" });
  });

  it("a judge that never recovers exhausts the budget and the pass still ENDS — terminal, not abandoned", () => {
    // The domain declares the judgment `terminal_unmeasured` once the budget is spent, which takes the case
    // off the worklist. The pass therefore finishes normally: the stall guard is not what stops this, and it
    // must not be — an attempt budget that expressed itself as an abandonment would be a different fact.
    expect(runPass(Number.POSITIVE_INFINITY)).toEqual({
      attempts: MAX_JUDGE_ATTEMPTS_PER_PASS,
      ending: "finish",
    });
  });

  it("the stall guard DOMINATES the retry budget — otherwise it cuts off a legitimate last attempt", () => {
    // The coupling the workflow bundle cannot express (workflow code may not import a value from
    // @everdict/domain), asserted from outside so it is checked rather than remembered.
    expect(MAX_STALLED_SCORE_ROUNDS).toBeGreaterThan(MAX_JUDGE_ATTEMPTS_PER_PASS);
  });

  it("…and still ends a worklist that cannot shrink at all — the loop owns its own termination", () => {
    // The pathology the guard exists for: a case whose id is absent from the effective dataset is skipped by
    // the judge stream WITHOUT leaving a row, so its progress stays `absent` forever and no attempt budget
    // ever engages. Judging is provider calls, so "re-plan until empty" would bill without end.
    let state: ScoreRoundState = { stalled: 0, round: 0 };
    let rounds = 0;
    for (;;) {
      const decision = decideScoreRound(["ghost#0"], state, false, 500);
      if (decision.kind !== "execute") {
        expect(decision).toEqual({ kind: "abandon", abandoned: 1 });
        break;
      }
      state = decision.state;
      rounds += 1;
      expect(rounds).toBeLessThanOrEqual(MAX_STALLED_SCORE_ROUNDS + 1); // bounded, and provably so
    }
  });
});

// Trust suite — TRUST-64.
//
// A LATER ROUND'S FIRST ATTEMPT OUTRANKS AN EARLIER ROUND'S LAST ONE — INSIDE ONE WORKFLOW EXECUTION.
//
// TRUST-54 certifies the same sentence across a continue-as-new, which was the whole story while rotation was
// the only thing that produced a new activity execution. The replan loop made that false: every round
// schedules a new execution and Temporal's `attempt` restarts at 1 in each, so a claim whose ordinal only
// moved on rotation refused its own pass's fresh judgment as stale — and the case could never finish. This
// drives the REAL round decision against the REAL Postgres arbiter, which is the only place the two halves of
// the claim meet.
const describeTrustPg =
  process.env.EVERDICT_TRUST_SUITE === "1" && (process.env.EVERDICT_TRUST_DATABASE_URL ?? process.env.DATABASE_URL)
    ? describe
    : describe.skip;

describeTrustPg("TRUST-64 — a replan round supersedes the round before it (real Postgres)", () => {
  it("round 0 attempt 2 is superseded by round 1 attempt 1, with no rotation in between", async () => {
    const { PgScoringStageStore, makePool, migrate, sqlClient } = await import("@everdict/db");
    const url = process.env.EVERDICT_TRUST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (url === undefined) throw new Error("guarded above");
    const pool = makePool(url);
    const client = sqlClient(pool);
    await migrate(client);
    const stage = new PgScoringStageStore(client);
    const scorecardId = `sc-round-${Date.now().toString(36)}`;
    const passId = "pass-A";
    const row = (value: number, generation: number, attempt: number) => ({
      caseKey: KEY,
      judgeId: "grader",
      scores: [{ graderId: "grader", metric: "judge:grader", value, pass: value === 1 }],
      claim: { generation, attempt },
    });

    try {
      // The workflow's OWN ordinal, advanced by the production decision — never a number the test picked.
      let state: ScoreRoundState = { stalled: 0, round: 0 };
      const first = decideScoreRound([KEY], state, false, 500);
      if (first.kind !== "execute") throw new Error(first.kind);
      state = first.state;
      // Round 1's activity times out once and its retry writes a retryable unmeasured verdict.
      expect(await stage.stage(scorecardId, passId, [row(0, state.round, 2)])).toHaveLength(1);

      // No rotation. The loop simply re-plans, because the case is still pending.
      const second = decideScoreRound([KEY], { ...state, remaining: undefined }, false, 500);
      if (second.kind !== "execute") throw new Error(second.kind);
      state = second.state;
      // A NEW activity execution — Temporal starts it at attempt 1 again.
      expect(await stage.stage(scorecardId, passId, [row(1, state.round, 1)])).toHaveLength(1);

      const staged = await stage.staged(scorecardId, passId);
      expect(staged[0]?.claim).toEqual({ generation: 2, attempt: 1 });
      expect((staged[0]?.scores?.[0] as { value: number }).value).toBe(1); // the measured verdict stands
      await stage.clear(scorecardId, passId);
    } finally {
      await pool.end();
    }
  });
});
