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

    let state: ScoreRoundState = { stalled: 0 };
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
    let state: ScoreRoundState = { stalled: 0 };
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
