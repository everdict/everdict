import type { GradeContext } from "@everdict/contracts";
import { toScores } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type Judge, JudgeGrader } from "./judge.js";

// arch-review 19 P1. The inline judge's criteria namespace under its own id, so the same logical judge reads
// the same way whether it was wired inline or registered — and cannot land inside another judge's family.
//
// Before this, an inline criterion was `judge:<criterion>`: two segments, which the ladder reads as a DECIDING
// judge verdict, while the same judge registered produced `judge:<id>:<criterion>` — three segments, which it
// reads as diagnostic. So a criterion failing under an overall pass sank the case inline and was informational
// when registered. And `judge:<criterion>` is literally the family of a registered judge whose id matches that
// criterion name, so re-scoring that judge would strip a row it never owned.
describe("inline judge criteria are namespaced", () => {
  const criteria = [{ id: "accuracy", description: "is it right?", weight: 1 }];
  const judge = {
    judge: async () => ({
      pass: true,
      score: 1,
      reason: "ok",
      criteria: [{ id: "accuracy", pass: false, score: 0, reason: "no" }],
    }),
  } as unknown as Judge;
  const ctx = {
    case: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    observations: { kind: "unobserved", reason: "no_environment" },
  } as unknown as GradeContext;

  it("namespaced: a criterion is three segments deep — DIAGNOSTIC, exactly as a registered judge's is", async () => {
    const grader = new JudgeGrader(judge, { id: "quality", criteria, namespaceCriteria: true });
    expect(toScores(await grader.grade(ctx)).map((s) => s.metric)).toEqual(["judge", "judge:quality:accuracy"]);
  });

  it("un-namespaced (the registered / code-judge construction) is unchanged — its own rewrite adds the id", async () => {
    // Setting it there too would produce `judge:<id>:<id>:<criterion>`. The runner's rewrite is the namespace
    // on that path, and there must be exactly one.
    const grader = new JudgeGrader(judge, { id: "quality", criteria });
    expect(toScores(await grader.grade(ctx)).map((s) => s.metric)).toEqual(["judge", "judge:accuracy"]);
  });

  it("the OVERALL metric is untouched in both — it already decides in both wirings", async () => {
    // Renaming it would break the metric continuity of every existing trend for no correctness gain, which is
    // why the fix is scoped to criteria.
    const grader = new JudgeGrader(judge, { id: "quality", namespaceCriteria: true });
    expect(toScores(await grader.grade(ctx))[0]?.metric).toBe("judge");
  });
});
