import type { GradeContext, Grader, Score } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { safeGrade } from "./safe-grade.js";

const CTX = {
  case: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  trace: [],
  snapshot: { kind: "browser", url: "", dom: "", console: [] },
} as unknown as GradeContext;

describe("safeGrade — isolate a grader's run-time failure", () => {
  it("passes a healthy grader's score through unchanged (as a one-element list)", async () => {
    const ok: Grader = {
      id: "judge",
      grade: async (): Promise<Score> => ({ graderId: "judge", metric: "judge", value: 1, pass: true }),
    };
    const scores = await safeGrade(ok, CTX);
    expect(scores).toEqual([{ graderId: "judge", metric: "judge", value: 1, pass: true }]);
  });

  it("collects a multi-metric grader's Score[] in order (multi-metric contract)", async () => {
    const multi: Grader = {
      id: "rubric-judge",
      grade: async (): Promise<Score[]> => [
        { graderId: "rubric-judge", metric: "judge", value: 0.8, pass: true },
        { graderId: "rubric-judge", metric: "judge:accuracy", value: 0.9, pass: true },
        { graderId: "rubric-judge", metric: "judge:style", value: 0.7 },
      ],
    };
    const scores = await safeGrade(multi, CTX);
    expect(scores.map((s) => s.metric)).toEqual(["judge", "judge:accuracy", "judge:style"]);
  });

  it("turns a throwing grader into a visible error score instead of propagating (pass left undefined, not FAIL)", async () => {
    // Given: a grader that throws at scoring time (e.g. a judge LLM/transport hiccup)
    const flaky: Grader = {
      id: "judge",
      grade: async (): Promise<Score> => {
        throw new Error("judge upstream 503");
      },
    };
    // When: it is graded via safeGrade
    const [score] = await safeGrade(flaky, CTX);
    // Then: the failure is captured as a score (never thrown) so the case + sibling graders survive
    expect(score?.graderId).toBe("judge");
    expect(score?.value).toBe(0);
    expect(score?.pass).toBeUndefined(); // excluded from passRate — an honest "not scored", not a false FAIL
    expect(score?.detail).toContain("judge upstream 503");
    expect(score?.detail).toContain("[grader-error]");
  });

  it("stringifies a non-Error throw", async () => {
    const weird: Grader = {
      id: "steps",
      grade: (): Promise<Score> => Promise.reject("boom"), // a non-Error rejection
    };
    const [score] = await safeGrade(weird, CTX);
    expect(score?.detail).toContain("boom");
  });
});
