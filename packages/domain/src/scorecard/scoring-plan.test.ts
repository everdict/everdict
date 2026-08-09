import type { Score } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  MAX_JUDGE_ATTEMPTS_PER_PASS,
  hasMeasuredJudgeVerdict,
  judgeAttemptsOf,
  judgePending,
  judgeProgress,
  stampJudgeAttempts,
  stripJudgeScores,
} from "./scoring-plan.js";

// arch-review 11 P0: measurement semantics and ORCHESTRATION semantics are different questions, and a single
// boolean answered both. A judge that can never produce a verdict on this case still has "no measured
// verdict", so the planner kept selecting it — every continuation, forever, paying a provider call each time.
describe("judgeProgress — a pass has to be able to finish", () => {
  const row = (over: Partial<Score> = {}): Score =>
    ({
      graderId: "q",
      metric: "judge:q",
      status: "unmeasured",
      reason: "unsupported",
      retryable: false,
      ...over,
    }) as Score;

  it("calls a NON-retryable unmeasured terminal — the fix is config plus a new pass, which its own flag says", () => {
    expect(judgeProgress({ scores: [row()] }, "q")).toBe("terminal_unmeasured");
    expect(judgePending({ scores: [row()] }, [{ id: "q" }])).toBe(false);
  });

  it("keeps a RETRYABLE unmeasured pending — until its pass-local attempt budget is spent", () => {
    const retryable = (attempts?: number) =>
      row({
        reason: "grader_error",
        retryable: true,
        ...(attempts !== undefined ? { attempts } : {}),
      } as Partial<Score>);
    expect(judgeProgress({ scores: [retryable()] }, "q")).toBe("retryable_unmeasured");
    expect(judgeProgress({ scores: [retryable(MAX_JUDGE_ATTEMPTS_PER_PASS - 1)] }, "q")).toBe("retryable_unmeasured");
    // …and at the budget it stops, so a judge failing the same transient way forever cannot hold a pass open.
    expect(judgeProgress({ scores: [retryable(MAX_JUDGE_ATTEMPTS_PER_PASS)] }, "q")).toBe("terminal_unmeasured");
    expect(judgePending({ scores: [retryable(MAX_JUDGE_ATTEMPTS_PER_PASS)] }, [{ id: "q" }])).toBe(false);
  });

  it("an absent judgment is pending and a measured one is done — the two ends stay where they were", () => {
    expect(judgeProgress({ scores: [] }, "q")).toBe("absent");
    expect(judgeProgress({ scores: [{ graderId: "q", metric: "judge:q", value: 1, pass: true }] }, "q")).toBe(
      "measured",
    );
  });

  it("terminal-unmeasured is DONE for orchestration and still NOT a verdict for measurement", () => {
    // The distinction the whole type exists for: the case leaves the worklist and stays unverdicted. Reading
    // it as a verdict would be the "absence of evidence as evidence" failure the verdict work exists to kill.
    const plane = { scores: [row()] };
    expect(judgePending(plane, [{ id: "q" }])).toBe(false);
    expect(hasMeasuredJudgeVerdict(plane, "q")).toBe(false);
  });

  it("carries the attempt count ACROSS the strip a re-score always performs", () => {
    // Without this the counter resets on every attempt — a budget that resets is not a budget.
    const before = { scores: [row({ reason: "grader_error", retryable: true, attempts: 1 } as Partial<Score>)] };
    const prior = judgeAttemptsOf(before, [{ id: "q" }]);
    expect(prior.get("q")).toBe(1);
    const afterStrip = stripJudgeScores(before.scores, [{ id: "q" }]);
    expect(afterStrip).toEqual([]);
    const rejudged = stampJudgeAttempts([row({ reason: "grader_error", retryable: true })], [{ id: "q" }], prior);
    expect(rejudged[0]).toMatchObject({ attempts: 2 });
  });

  it("never stamps a counter onto a variant whose schema forbids it", () => {
    // `invalid` is strict — an extra field would make the NEXT parse of this row throw, turning a retry
    // budget into a deserialization failure.
    const invalid: Score = { graderId: "q", metric: "judge:q", status: "invalid", reason: "contract_violation" };
    expect(stampJudgeAttempts([invalid], [{ id: "q" }], new Map([["q", 2]]))).toEqual([invalid]);
    expect(judgeProgress({ scores: [invalid] }, "q")).toBe("terminal_unmeasured");
  });
});
