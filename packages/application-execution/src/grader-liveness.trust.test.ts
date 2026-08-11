import { EvalCaseSchema, type GradeContext, type Grader, type Score } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { safeGrade } from "./safe-grade.js";

// Trust suite (docs/trust-certification.md) — TRUST-133.
//
// A GRADER THAT HANGS IS A FAILURE THAT BECOMES NOTHING AT ALL.
//
// `safeGrade` has always turned a grader that THROWS into a visible `unmeasured` score, and the suite has
// certified that no failure becomes a normal number. A grader that simply never returns was outside that
// vocabulary entirely: the await sat there, the case never settled, and the batch waiting on it stopped
// making progress without recording one fact about why. It is the worse failure of the two — a wrong number
// can at least be seen and disputed.
//
// This runs against a REAL clock. The case declares a one-second budget and the scenario waits for it, so
// what is certified is that the deadline fires in wall-clock time rather than that a fake timer was advanced.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const context = (timeoutSec: number): GradeContext => ({
  case: EvalCaseSchema.parse({
    id: "c-1",
    env: { kind: "prompt" },
    task: "do the thing",
    timeoutSec,
  }),
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
});

const hangs: Grader = {
  id: "hangs",
  grade: () => new Promise<Score>(() => {}), // never resolves, never rejects — the case this exists for
};

const answers: Grader = {
  id: "answers",
  grade: async () => ({ graderId: "answers", metric: "answers", value: 1, status: "measured" as const }),
};

describeTrust("TRUST-133 — a grader that hangs settles as a fact, inside the case's own budget", () => {
  it("returns unmeasured/grader_timeout rather than never returning", async () => {
    const started = Date.now();
    const scores = await safeGrade(hangs, context(1));
    const elapsed = Date.now() - started;
    expect(scores).toEqual([
      {
        graderId: "hangs",
        metric: "hangs",
        status: "unmeasured",
        reason: "grader_timeout",
        // A hang is a liveness fact about this ATTEMPT, not a verdict about the case — re-scoring this one
        // grader can still recover the measurement, exactly as a transport throw can.
        retryable: true,
        detail: "[grader-timeout] 'hangs' did not return within the case's 1s budget",
      },
    ]);
    // The deadline is the case's, honoured in wall-clock time: it waited, and it did not wait forever.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it("is UNMEASURED, so the hang never reaches an aggregate as a number", async () => {
    const [score] = await safeGrade(hangs, context(1));
    // The whole point of the unmeasured variant: there is no `value` to leak into a mean or a pass rate.
    expect(score).not.toHaveProperty("value");
  }, 20_000);

  it("leaves a grader that answers in time untouched — the deadline is a bound, not a policy", async () => {
    // The regression this guards: a bound taken from a constant this module invented, rather than from the
    // case's own declaration, would turn a legitimately slow judge (a delegated harness dispatching a whole
    // agent) into a failure. The budget is the user's statement of how long this case may take.
    expect(await safeGrade(answers, context(1))).toEqual([
      { graderId: "answers", metric: "answers", value: 1, status: "measured" },
    ]);
  });
});
