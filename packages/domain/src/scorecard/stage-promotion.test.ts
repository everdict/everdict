import type { CaseResult, Score } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { scorePlaneDigest } from "./scoring-revision.js";
import { promoteStagedJudgments, stagePromotionRefusal } from "./stage-promotion.js";

// The contract step's MERGE (arch-review 43 ①). Every piece of evidence gathered for the stage promotion so
// far compares DATA — staged bytes against plane bytes — which certifies the dual write and says nothing
// about the code that would consume it. These pin the merge itself: what a promotion keeps, what it replaces,
// and what it must never invent.

const judge = (id: string, value: number): Score => ({
  graderId: id,
  metric: `judge:${id}`,
  value,
  pass: value === 1,
});
const grader: Score = { graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true };

function result(caseId: string, scores: Score[], trial?: number): CaseResult {
  return {
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores,
    ...(trial !== undefined ? { trial } : {}),
  };
}

const parity = (overrides: Partial<Parameters<typeof stagePromotionRefusal>[0]> = {}) => ({
  scorecardId: "sc-1",
  passId: "pass-1",
  completed: true,
  expectedJudged: 1,
  staged: 1,
  missingFromStage: [] as string[],
  matched: 1,
  mismatched: [] as string[],
  orphaned: [] as string[],
  ...overrides,
});

describe("promoteStagedJudgments — the promoted plane is the CARRIER plane with the produced families replaced", () => {
  it("replaces the staged judge's rows and leaves inherited evidence alone", () => {
    // Given a case carrying a grader row (inherited), judge a (this pass's) and judge b (another pass's)
    const carrier = [result("c1", [grader, judge("a", 0), judge("b", 1)])];
    // When this pass's stage says judge a decided 1
    const promoted = promoteStagedJudgments(
      carrier,
      [{ caseKey: "c1#0", judgeId: "a", scores: [judge("a", 1)] }],
      [{ id: "a" }],
    );
    // Then a is the STAGE's judgment, and the grader + judge b are untouched — a stage is a delta, and a
    // promotion that read it as the whole desired plane would drop everything it does not mention.
    const scores = promoted[0]?.scores ?? [];
    expect(scores.find((s) => s.metric === "judge:a")).toMatchObject({ value: 1 });
    expect(scores.find((s) => s.metric === "judge:b")).toMatchObject({ value: 1 });
    expect(scores.find((s) => s.metric === "tests_pass")).toBeDefined();
  });

  it("leaves a case the stage never mentions exactly as the carrier has it", () => {
    // Absence in a delta means "this pass produced nothing here" — never "delete what is there". Whether the
    // absence is legitimate is the parity report's question, asked before the promotion is allowed at all.
    const carrier = [result("c1", [judge("a", 1)]), result("c2", [judge("a", 0)])];
    const promoted = promoteStagedJudgments(
      carrier,
      [{ caseKey: "c1#0", judgeId: "a", scores: [judge("a", 1)] }],
      [{ id: "a" }],
    );
    expect(scorePlaneDigest(promoted)).toBe(scorePlaneDigest(carrier));
  });

  it("ignores a staged row for a judge this pass did not select", () => {
    // The stage is keyed per pass, but a pass's SELECTION is what makes a row its delta. Promoting an
    // unselected judge's row would rewrite a family this pass had no authority over.
    const carrier = [result("c1", [judge("a", 1), judge("b", 1)])];
    const promoted = promoteStagedJudgments(
      carrier,
      [{ caseKey: "c1#0", judgeId: "b", scores: [judge("b", 0)] }],
      [{ id: "a" }],
    );
    expect(promoted[0]?.scores.find((s) => s.metric === "judge:b")).toMatchObject({ value: 1 });
  });

  it("addresses cases by (caseId, trial) — a trial is a different judgment of a different execution", () => {
    const carrier = [result("c1", [judge("a", 0)], 0), result("c1", [judge("a", 0)], 1)];
    const promoted = promoteStagedJudgments(
      carrier,
      [{ caseKey: "c1#1", judgeId: "a", scores: [judge("a", 1)] }],
      [{ id: "a" }],
    );
    expect(promoted[0]?.scores[0]).toMatchObject({ value: 0 });
    expect(promoted[1]?.scores[0]).toMatchObject({ value: 1 });
  });

  it("a divergent staged judgment MOVES the plane digest — the guard the settle re-checks is not vacuous", () => {
    const carrier = [result("c1", [judge("a", 0)])];
    const promoted = promoteStagedJudgments(
      carrier,
      [{ caseKey: "c1#0", judgeId: "a", scores: [judge("a", 1)] }],
      [{ id: "a" }],
    );
    expect(scorePlaneDigest(promoted)).not.toBe(scorePlaneDigest(carrier));
  });
});

describe("stagePromotionRefusal — one spelling of why a pass may not be promoted", () => {
  it("says nothing about a pass whose stage and plane agree completely", () => {
    expect(stagePromotionRefusal(parity())).toBeUndefined();
  });

  it("refuses an UNMEASURED pass, carrying the reason the comparison could not run", () => {
    const refusal = stagePromotionRefusal(parity({ completed: false, failure: "stage read threw" }));
    expect(refusal).toContain("stage read threw");
  });

  it("names the dimension that blocked — a judgment judged but never staged", () => {
    // The failure a stage-only comparison is structurally blind to: promoting here would silently drop it.
    const refusal = stagePromotionRefusal(parity({ expectedJudged: 2, missingFromStage: ["c2#0"], matched: 1 }));
    expect(refusal).toContain("missingFromStage=1");
  });
});
