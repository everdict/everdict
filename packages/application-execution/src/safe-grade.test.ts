import type { GradeContext, Grader, Score } from "@everdict/contracts";
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
      // What the JudgeGrader implementation owns by construction (arch-review 17 P0-2 / 18 P0-1).
      ownsJudgeVerdict: true,
      grade: async (): Promise<Score> => ({ graderId: "judge", metric: "judge", value: 1, pass: true }),
    };
    const scores = await safeGrade(ok, CTX);
    expect(scores).toEqual([{ graderId: "judge", metric: "judge", value: 1, pass: true }]);
  });

  it("collects a multi-metric grader's Score[] in order (multi-metric contract)", async () => {
    const multi: Grader = {
      id: "rubric-judge",
      ownsJudgeVerdict: true,
      grade: async (): Promise<Score[]> => [
        { graderId: "rubric-judge", metric: "judge", value: 0.8, pass: true },
        { graderId: "rubric-judge", metric: "judge:accuracy", value: 0.9, pass: true },
        { graderId: "rubric-judge", metric: "judge:style", value: 0.7 },
      ],
    };
    const scores = await safeGrade(multi, CTX);
    expect(scores.map((s) => s.metric)).toEqual(["judge", "judge:accuracy", "judge:style"]);
  });

  it("turns a throwing grader into an unmeasured score instead of propagating (never a measurement)", async () => {
    // Given: a grader that throws at scoring time (e.g. a judge LLM/transport hiccup)
    const flaky: Grader = {
      id: "judge",
      grade: async (): Promise<Score> => {
        throw new Error("judge upstream 503");
      },
    };
    // When: it is graded via safeGrade
    const [score] = await safeGrade(flaky, CTX);
    // Then: the failure is captured as a score (never thrown) so the case + sibling graders survive —
    // and it is UNMEASURED: it carries no `value` and no `pass` AT ALL, so there is no placeholder number
    // for an aggregate to pick up and no false FAIL for a passRate to count.
    expect(score).toEqual({
      graderId: "judge",
      metric: "judge",
      status: "unmeasured",
      reason: "grader_error",
      retryable: true, // a scoring-time throw is transient — re-scoring can recover it
      detail: expect.stringContaining("[grader-error] judge upstream 503"),
    });
    expect(score !== undefined && "value" in score).toBe(false);
  });

  it("a grader RETURNING garbage becomes a visible invalid score — a bug, never a number", async () => {
    const broken: Grader = {
      id: "buggy",
      grade: async (): Promise<Score> => ({ graderId: "buggy", metric: "quality", value: Number.NaN, pass: true }),
    };
    const [score] = await safeGrade(broken, CTX);
    // The invalid variant has neither value nor pass nor retryable: a deterministic grader bug is not a
    // number, not a verdict, and not something a retry worklist should ever pick up.
    expect(score).toEqual({
      graderId: "buggy",
      metric: "quality",
      status: "invalid",
      reason: "contract_violation",
      detail: expect.stringContaining("[invalid-score]"),
    });
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
