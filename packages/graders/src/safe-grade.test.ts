import type { GradeContext, Grader, Score } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { safeGrade } from "./safe-grade.js";

const CTX = {
  case: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  trace: [],
  snapshot: { kind: "browser", url: "", dom: "", console: [] },
} as unknown as GradeContext;

describe("safeGrade — isolate a grader's run-time failure", () => {
  it("passes a healthy grader's score through unchanged", async () => {
    const ok: Grader = {
      id: "judge",
      grade: async (): Promise<Score> => ({ graderId: "judge", metric: "judge", value: 1, pass: true }),
    };
    const score = await safeGrade(ok, CTX);
    expect(score).toEqual({ graderId: "judge", metric: "judge", value: 1, pass: true });
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
    const score = await safeGrade(flaky, CTX);
    // Then: the failure is captured as a score (never thrown) so the case + sibling graders survive
    expect(score.graderId).toBe("judge");
    expect(score.value).toBe(0);
    expect(score.pass).toBeUndefined(); // excluded from passRate — an honest "not scored", not a false FAIL
    expect(score.detail).toContain("judge upstream 503");
    expect(score.detail).toContain("[grader-error]");
  });

  it("stringifies a non-Error throw", async () => {
    const weird: Grader = {
      id: "steps",
      grade: (): Promise<Score> => Promise.reject("boom"), // a non-Error rejection
    };
    const score = await safeGrade(weird, CTX);
    expect(score.detail).toContain("boom");
  });
});
