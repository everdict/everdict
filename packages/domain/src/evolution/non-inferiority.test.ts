import { describe, expect, it } from "vitest";
import { nonInferiorityOf } from "./non-inferiority.js";

const policy = { version: "hoeffding-v1" as const, margin: 0.05, alpha: 0.05, minimumTrials: 100 };
const row = (caseId: string, baselineRate = 0.8, candidateRate = 0.8, trials = 10000) => ({
  caseId,
  baselineRate,
  candidateRate,
  baselineTrials: trials,
  candidateTrials: trials,
});
describe("predeclared non-inferiority", () => {
  it("distinguishes low power from evidence of no material degradation", () => {
    expect(nonInferiorityOf(policy, ["a", "b"], 10, [row("a", 0.8, 0.8, 5), row("b", 0.8, 0.8, 5)]).status).toBe(
      "inconclusive",
    );
    expect(nonInferiorityOf(policy, ["a", "b"], 10, [row("a"), row("b")]).status).toBe("non_inferior");
  });
  it("detects a loss beyond the margin and refuses a missing held-out case", () => {
    expect(nonInferiorityOf(policy, ["a", "b"], 10, [row("a", 0.8, 0.5), row("b")]).status).toBe("inferior");
    expect(nonInferiorityOf(policy, ["a", "b"], 10, [row("a")]).status).toBe("inconclusive");
  });
  it("widens confidence intervals for a larger experiment family", () => {
    const one = nonInferiorityOf(policy, ["a"], 1, [row("a")]);
    const many = nonInferiorityOf(policy, ["a"], 100, [row("a")]);
    expect(many.cases[0]?.lowerDelta).toBeLessThan(one.cases[0]?.lowerDelta ?? -1);
  });
});
