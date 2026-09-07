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

// The production shapes. ⚠️ EVERY CORRECTNESS GRADER THIS REPOSITORY SHIPS EMITS `pass`, AND THESE FIXTURES
// USED NOT TO — `reward-file`, `swe-bench`, `command`, `script-score` and `world-state` all set it, and
// omitting it here is what let the suite certify a `some((s) => s.value > 0)` reading of "did it pass" for a
// release. A fixture that is easier to write than the producer's real output is a fixture that can only test
// the easier question.
const passing = (caseId: string) => ({
  caseId,
  scores: [{ graderId: "reward-file", metric: "reward", value: 1, pass: true }],
});
const failing = (caseId: string) => ({
  caseId,
  scores: [{ graderId: "reward-file", metric: "reward", value: 0, pass: false }],
});
// The three trace graders, verbatim from `packages/graders/src/trace-graders.ts`. Positive on every run that
// happened at all, no `pass`, no claim about correctness — and routinely attached, because a harness that
// wants cost or step accounting declares them.
const withTraceGraders = (caseId: string) => ({
  caseId,
  scores: [
    { graderId: "reward-file", metric: "reward", value: 0, pass: false },
    { graderId: "steps", metric: "tool_calls", value: 12 },
    { graderId: "cost", metric: "usd", value: 0.0431 },
    { graderId: "latency", metric: "span", value: 8123 },
  ],
});
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

  // ── THE DEFECT THIS CHECK WAS BUILT TO CATCH, WEARING THE CHECK'S OWN CLOTHES ──────────────────────
  //
  // RED on the pre-fix code, which asked `row.scores.filter(isMeasured).some((s) => s.value > 0)`:
  //   AssertionError: expected [ 'a' ] to deeply equal []
  //
  // The case FAILED its correctness grader and cost $0.0431 to do it. `value > 0` cannot tell a magnitude
  // from a verdict, so the positive control certified the exam most reliably on precisely the wave that
  // motivated it — a SpreadsheetBench run scoring every case zero, while measuring cost.
  it("A COST IS NOT A PASS: a magnitude from an observational grader may not prove the exam", () => {
    const proof = examProofOf(["a"], { results: [withTraceGraders("a")] });
    expect(proof.proven).toEqual([]);
    expect(proof.unproven).toEqual(["a"]);
  });

  it("and the trace graders do not suppress a real pass either — they simply do not decide", () => {
    const proof = examProofOf(["a"], {
      results: [
        {
          caseId: "a",
          scores: [
            { graderId: "reward-file", metric: "reward", value: 1, pass: true },
            { graderId: "cost", metric: "usd", value: 0.0431 },
          ],
        },
      ],
    });
    expect(proof.proven).toEqual(["a"]);
  });

  // A categorical metric reaches the same wrong end without any auxiliary grader: `value` is documented as
  // the ordinal key (bronze<silver<gold ⇒ 1<2<3), so the WORST tier is 1 and `value > 0` read it as proof.
  it("THE WORST TIER IS NOT A PASS: a categorical ordinal key is an ordering, not a verdict", () => {
    const proof = examProofOf(["a"], {
      results: [
        { caseId: "a", scores: [{ graderId: "judge", metric: "judge", value: 1, label: "bronze", pass: false }] },
      ],
    });
    expect(proof.proven).toEqual([]);
  });

  // A case killed before it produced an outcome has no verdict, so it proves nothing — the same third value
  // an unmeasured row gets, arriving by the other door. `caseVerdict` reads `failure`; a port narrowed to
  // `{caseId, scores}` could not have passed it, which is why the port carries it now.
  it("A CANCELLED CASE PROVES NOTHING: partial work under a kill is not an outcome", () => {
    const proof = examProofOf(["a"], {
      results: [
        {
          caseId: "a",
          scores: [{ graderId: "reward-file", metric: "reward", value: 1, pass: true }],
          failure: {
            code: "CANCELLED",
            stage: "grade" as const,
            message: "stopped",
            class: "infra" as const,
            retryable: false,
          },
        },
      ],
    });
    expect(proof.proven).toEqual([]);
    expect(proof.unproven).toEqual(["a"]);
  });

  // The batch's OWN stamped policy decides, not the built-in ladder. A composed policy that declares the
  // correctness metric EXCLUDED has nothing left to decide with, and "nothing decided" is unproven — not a
  // silent fallback to whatever the default ladder would have said.
  it("the batch's stamped policy is what decides — a second opinion is not the record's", () => {
    const excluded = examProofOf(
      ["a"],
      { results: [passing("a")] },
      {
        id: "test",
        version: "1.0.0",
        metrics: [{ match: { metric: "reward" }, authority: "objective" as const, verdictRole: "excluded" as const }],
        rungs: { ground_truth: "all" as const, objective: "all" as const, judge: "all" as const },
        fallback: "none" as const,
      },
    );
    expect(excluded.proven).toEqual([]);
  });
});
