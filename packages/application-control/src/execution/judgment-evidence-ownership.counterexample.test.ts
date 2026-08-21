import type { CaseResult, EvalCase } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { JudgeEvidenceOutcome } from "../ports/judge-runner.js";
import { ScoringService } from "./scoring-service.js";

// ── "CAN BE RE-READ" IS ABOUT THIS EXECUTION'S OWN ACCOUNT (arch-review 59 P1) ───────────────────────
//
// `result.judgmentsSealed` is a vouch: every judgment on this case can be re-read. It was withdrawn on one
// arm — `unsealed`, the seal that failed — and the runner had exactly one other way to not hold this
// judgment's evidence, which it reported as success.
//
// A trajectory keeps the FIRST segment per emitter. When one already exists, the seal DISCARDS this
// execution's events and the earlier execution's stand; the store says so (`created: false`) and the runner
// used to throw that away. So the account on file was real, re-readable, and somebody else's, and the vouch
// said the case's judgment plane was complete.
//
// That is a wrong claim rather than a missing one, which is the whole distinction this field exists to draw —
// and it is the one signal that would detect a slip in the invocation-scoped emitter grammar (`judge:<id>#
// <pass>.<gen>.<attempt>`) that arch-reviews 41 and 51 built precisely to stop first-write-wins collisions.
//
// The producer half is pinned in `apps/api/src/core/execution/judge-seal-outcome.counterexample.test.ts`.
// This is the CONSUMER half, deliberately separate because they break independently — and because the
// producer's fix stayed green here under neutralization until this file existed.
//
// Seen RED with the `superseded` arm not withdrawing the vouch, observed:
//   a case vouched that every judgment can be re-read while one judgment's account was another execution's:
//   expected true to be false

const CASE = {
  id: "c1",
  task: "t",
  env: { kind: "prompt" },
  graders: [],
  timeoutSec: 60,
  tags: [],
} as unknown as EvalCase;

const SPEC = { id: "quality", kind: "model", provider: "anthropic", model: "m", tags: [] };

// A runner that answers a real verdict and whatever evidence outcome the test names.
const serviceWith = (evidence: JudgeEvidenceOutcome) =>
  new ScoringService({
    judgeRunner: {
      run: async () => ({
        scores: [{ graderId: "quality", metric: "judge:quality", value: 1, pass: true }],
        evidence,
      }),
    },
  } as never);

async function judged(evidence: JudgeEvidenceOutcome): Promise<CaseResult> {
  const result = {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    scores: [],
    snapshot: { kind: "prompt", output: "done" },
  } as unknown as CaseResult;
  await serviceWith(evidence).applyJudgesToCase(
    "acme",
    CASE,
    [{ spec: SPEC }] as never,
    result,
    undefined,
    undefined,
    "evd-run-r1",
    undefined,
    "pass-1",
  );
  return result;
}

describe("[R59 COUNTEREXAMPLE] a case vouches only for judgment evidence that is its own", () => {
  it("VOUCHES when the judgment's evidence is this execution's", async () => {
    // The control: the assertions below have to be about the arm under test, not about the vouch having
    // stopped working for some other reason.
    const result = await judged({ status: "sealed", runId: "evd-run-r1", emitter: "judge:quality#pass-1" });
    expect(result.judgmentsSealed, "a sealed judgment did not produce a vouch at all").toBe(true);
    expect(result.scores, "the judge never ran, so this file is measuring nothing").toHaveLength(1);
  });

  it("WITHDRAWS the vouch when the account on file is an earlier execution's", async () => {
    const result = await judged({ status: "superseded", runId: "evd-run-r1", emitter: "judge:quality#pass-1" });
    expect(
      result.judgmentsSealed,
      "a case vouched that every judgment can be re-read while one judgment's account was another execution's",
    ).toBe(false);
    // The verdict still stands. Evidence is best-effort by contract, and withdrawing the vouch must not cost
    // a verdict that was really reached — otherwise the repair is worse than the defect.
    expect(result.scores).toHaveLength(1);
  });

  it("WITHDRAWS the vouch when the seal failed outright", async () => {
    const result = await judged({ status: "unsealed", reason: "trajectory store unavailable" });
    expect(result.judgmentsSealed).toBe(false);
    expect(result.scores).toHaveLength(1);
  });

  it("keeps the vouch when there was nothing to seal onto", async () => {
    // No trajectory to be evidence ON is not a loss — reporting it as one would make every store-less
    // deployment and every preview look like a degraded verdict.
    const result = await judged({ status: "not_applicable" });
    expect(result.judgmentsSealed).toBe(true);
  });
});
