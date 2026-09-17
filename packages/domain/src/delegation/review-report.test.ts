import type { DelegateReport, DelegationBrief } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { reviewDelegateReport, tallyDelegateReport } from "./review-report.js";

const brief: Pick<DelegationBrief, "doneWhen"> = {
  doneWhen: [
    { id: "targets-pass", statement: "the two cases pass" },
    { id: "no-regression", statement: "no other case regresses" },
    { id: "one-lever", statement: "the diff changes one mechanism" },
  ],
};

const report = (
  over: Partial<Pick<DelegateReport, "answers" | "gateRuns">>,
): Pick<DelegateReport, "answers" | "gateRuns"> => ({ answers: [], gateRuns: [], ...over });

// ── WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────────────────────────
//
// Not "is the work good" — that is the supervisor's judgement and no function can take it. This answers the
// question that comes first and that a tired reader cannot settle: is the report even an ANSWER to the brief?
// A report that quietly skips two of three criteria reads exactly like one that met all three, because prose
// has no shape that makes an omission visible.
describe("a report is checked against the brief it was given", () => {
  it("names the criteria nobody answered", () => {
    const review = reviewDelegateReport(
      brief,
      report({ answers: [{ criterionId: "targets-pass", answer: "met", how: "observed", gateRunIds: [] }] }),
    );
    expect(review.unanswered).toEqual(["no-regression", "one-lever"]);
    expect(review.answersTheBrief).toBe(false);
  });

  // The dangerous one: the answer LOOKS valid. A delegate answering a brief that has since been edited files
  // a perfectly well-formed verdict against an id that is no longer asked for, and nothing about the answer
  // itself says so.
  it("names an answer to a criterion the brief does not contain", () => {
    const review = reviewDelegateReport(
      brief,
      report({
        answers: [
          { criterionId: "targets-pass", answer: "met", how: "asserted", gateRunIds: [] },
          { criterionId: "no-regression", answer: "met", how: "asserted", gateRunIds: [] },
          { criterionId: "one-lever", answer: "met", how: "asserted", gateRunIds: [] },
          { criterionId: "w4", answer: "met", how: "asserted", gateRunIds: [] },
        ],
      }),
    );
    expect(review.unknownCriteria).toEqual(["w4"]);
    expect(review.answersTheBrief).toBe(false);
  });

  // Two verdicts for one criterion is not a stronger claim — there is no rule for choosing between them, so
  // neither can be counted, and a reader who scrolls past the second one has been told something false.
  it("names a criterion answered twice rather than taking the last one", () => {
    const review = reviewDelegateReport(
      brief,
      report({
        answers: [
          { criterionId: "targets-pass", answer: "met", how: "asserted", gateRunIds: [] },
          {
            criterionId: "targets-pass",
            answer: "not_met",
            reason: "attempted_and_failed",
            how: "asserted",
            gateRunIds: [],
          },
          { criterionId: "no-regression", answer: "met", how: "asserted", gateRunIds: [] },
          { criterionId: "one-lever", answer: "met", how: "asserted", gateRunIds: [] },
        ],
      }),
    );
    expect(review.duplicated).toEqual(["targets-pass"]);
    expect(review.answersTheBrief).toBe(false);
  });

  // `observed` is the word that makes an answer evidence rather than opinion. An observation citing a
  // measurement nobody can find is an assertion wearing the other word — and it is the citation, not the
  // wording, that the supervisor would otherwise have to verify by hand.
  it("names an observed answer whose measurement is not in the report", () => {
    const review = reviewDelegateReport(
      brief,
      report({
        answers: [
          { criterionId: "targets-pass", answer: "met", how: "observed", gateRunIds: ["g-vitest", "g-ghost"] },
          { criterionId: "no-regression", answer: "met", how: "observed", gateRunIds: ["g-vitest"] },
          { criterionId: "one-lever", answer: "met", how: "asserted", gateRunIds: [] },
        ],
        gateRuns: [{ id: "g-vitest", command: "npx vitest run", exitCode: 0, metrics: [] }],
      }),
    );
    expect(review.danglingGateRuns).toEqual([{ criterionId: "targets-pass", gateRunIds: ["g-ghost"] }]);
    expect(review.answersTheBrief).toBe(false);
  });

  it("says a complete, corresponding report answers the brief", () => {
    const review = reviewDelegateReport(
      brief,
      report({
        answers: [
          { criterionId: "targets-pass", answer: "met", how: "observed", gateRunIds: ["g-vitest"] },
          {
            criterionId: "no-regression",
            answer: "not_met",
            reason: "needs_environment",
            how: "asserted",
            gateRunIds: [],
          },
          { criterionId: "one-lever", answer: "met", how: "asserted", gateRunIds: [] },
        ],
        gateRuns: [{ id: "g-vitest", command: "npx vitest run", exitCode: 0, metrics: [] }],
      }),
    );
    expect(review).toMatchObject({ unanswered: [], unknownCriteria: [], duplicated: [], danglingGateRuns: [] });
    // ⚠️ Answering the brief is NOT the same as meeting it — one criterion here is `not_met`, and the report
    // still corresponds. A function that conflated the two would make "you reported honestly" and "you
    // succeeded" the same verdict, which is the pressure that produces optimistic reports.
    expect(review.answersTheBrief).toBe(true);
  });
});

describe("the tally counts what was asked for", () => {
  it("counts each verdict and the silence", () => {
    expect(
      tallyDelegateReport(
        brief,
        report({
          answers: [
            { criterionId: "targets-pass", answer: "met", how: "asserted", gateRunIds: [] },
            {
              criterionId: "no-regression",
              answer: "not_met",
              reason: "attempted_and_failed",
              how: "asserted",
              gateRunIds: [],
            },
          ],
        }),
      ),
    ).toEqual({ total: 3, met: 1, notMet: 1, notRun: 0, unanswered: 1 });
  });

  // An answer to an id nobody asked for is a finding, never a contribution — otherwise a delegate could raise
  // its own score by answering criteria it invented.
  it("does not let an unknown criterion contribute to the count", () => {
    expect(
      tallyDelegateReport(
        brief,
        report({ answers: [{ criterionId: "invented", answer: "met", how: "asserted", gateRunIds: [] }] }),
      ),
    ).toEqual({ total: 3, met: 0, notMet: 0, notRun: 0, unanswered: 3 });
  });
});
