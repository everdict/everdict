import { describe, expect, it } from "vitest";
import { examProofOf } from "./exam-proof.js";

// ── AN EXAM NOBODY HAS EVER PASSED IS NOT KNOWN TO BE AN EXAM ────────────────────────────────────────
//
// The campaign certifies the COMPARISON — same cases, same judges, enough trials, no confounded axis — and
// never asks whether the measurement responds to a correct answer. A SpreadsheetBench wave ran round after
// round against a grader that scored 420 of the 912 published tasks zero without opening the agent's
// workbook: feeding it the benchmark's OWN answer workbooks produced `FAIL 3/3` on eight of eight sampled
// cases. Every refusal the gate made was right and the exam had never been an exam.
//
// The check is not "can an agent pass this" — that would block every hard benchmark. It is "does the scorer
// respond to a known-good answer", which is a property of the (case, grader) pair and costs one read: a
// scorecard the platform itself wrote, in which the case was MEASURED and PASSED.
//
// And the coverage is PLATFORM-DERIVED. The driver names one scorecard; it does not get to say what that
// scorecard proves (rule `protocol` L3 — provenance is born at the source, never asserted by the consumer).
//
// RED before `exam-proof.ts` existed:
//   Error: Failed to resolve import "./exam-proof.js"

// The production shapes: a measured score carries `status: "measured"` (or omits it, which means the same —
// `isMeasured`), and an unmeasured one names why it could not be scored.
const passing = (caseId: string) => ({ caseId, scores: [{ graderId: "reward-file", metric: "reward", value: 1 }] });
const failing = (caseId: string) => ({ caseId, scores: [{ graderId: "reward-file", metric: "reward", value: 0 }] });
const unmeasured = (caseId: string) => ({
  caseId,
  scores: [
    {
      graderId: "reward-file",
      metric: "reward",
      value: 0,
      status: "unmeasured" as const,
      retryable: false,
      reason: "missing_evidence" as const,
    },
  ],
});

describe("examProofOf — what a named scorecard actually proves about a frame", () => {
  it("counts only the frame's scenarios that were MEASURED AND PASSED", () => {
    const proof = examProofOf(["a", "b", "c"], {
      results: [passing("a"), failing("b"), passing("c")],
    });
    expect(proof).toEqual({ proven: ["a", "c"], unproven: ["b"], of: 3 });
  });

  it("A ZERO IS NOT A PROOF: the case every arm fails is exactly the one that may be unwinnable", () => {
    const proof = examProofOf(["a"], { results: [failing("a")] });
    expect(proof.proven).toEqual([]);
    expect(proof.unproven).toEqual(["a"]);
  });

  it("AN UNMEASURED ROW IS NOT A ZERO AND NOT A PASS — it proves nothing either way", () => {
    // The grader could not answer. Counting it as a failure would accuse a case nobody scored; counting it
    // as a pass would certify the exact instrument that could not run (rule `protocol` L2).
    const proof = examProofOf(["a"], { results: [unmeasured("a")] });
    expect(proof.proven).toEqual([]);
    expect(proof.unproven).toEqual(["a"]);
  });

  it("a case the scorecard never ran is unproven, not absent — the frame's scenario list is the question", () => {
    const proof = examProofOf(["a", "b"], { results: [passing("a")] });
    expect(proof).toEqual({ proven: ["a"], unproven: ["b"], of: 2 });
  });

  it("rows for cases OUTSIDE the frame prove nothing about it and are not counted", () => {
    const proof = examProofOf(["a"], { results: [passing("a"), passing("z"), passing("y")] });
    expect(proof).toEqual({ proven: ["a"], unproven: [], of: 1 });
  });

  it("ONE PASSING TRIAL IS ENOUGH: the question is whether the scorer can say yes, not how often", () => {
    // A flaky case is still a case whose grader responds. Requiring every trial to pass would refuse the
    // exams a campaign exists to improve.
    const proof = examProofOf(["a"], { results: [failing("a"), passing("a"), failing("a")] });
    expect(proof.proven).toEqual(["a"]);
  });

  it("an empty scorecard proves nothing, and says so rather than throwing", () => {
    expect(examProofOf(["a", "b"], { results: [] })).toEqual({ proven: [], unproven: ["a", "b"], of: 2 });
  });
});
