import { describe, expect, it } from "vitest";
import { EvalCaseSchema } from "./eval-case.js";

// Grading is chosen at run time (the scorecard's graders/judges), not per case — so a dataset case is usually pure
// {id, env, task, expected} data. The schema must accept a case with NO `graders` and default it to []; this fails
// on the pre-change schema where `graders` was a required array.
describe("EvalCaseSchema — graders is optional (run-time grading, not per-case)", () => {
  const base = { id: "case-1", env: { kind: "prompt" as const }, task: "Write a refusal email." };

  it("accepts a case with no graders and defaults them to []", () => {
    const parsed = EvalCaseSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.graders).toEqual([]);
  });

  it("keeps an explicit per-case grading plan when one is given", () => {
    const parsed = EvalCaseSchema.safeParse({ ...base, graders: [{ id: "tests-pass" }] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.graders).toEqual([{ id: "tests-pass" }]);
  });

  it("accepts `expected` as case data (an LLM judge reads it as the per-case criteria)", () => {
    const parsed = EvalCaseSchema.safeParse({ ...base, expected: "Polite; states the reason; offers an alternative." });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.expected).toBe("Polite; states the reason; offers an alternative.");
  });
});
