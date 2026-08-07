import type { CaseResult, Score } from "@everdict/contracts";
import { ScoreSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { caseReason, hasMeasuredJudgeVerdict, isJudgeMetricOf, stripJudgeScores } from "./scorecard-shared.js";

// A CaseResult that failed with a trace error carrying `message`.
function erroredCase(message: string): CaseResult {
  return {
    caseId: "c1",
    harness: "h@1",
    trace: [{ t: 0, kind: "error", message }],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
  };
}

describe("caseReason", () => {
  it("carries the full failure message into the progress step (no mid-sentence cut at 140 chars)", () => {
    // Regression: the reason used to be sliced to 140 chars, so the live "Progress" timeline showed a truncated,
    // unreadable error. A real dispatch/harness error is easily longer than that.
    const message = `dispatch failed: ${"x".repeat(600)} at the very end`;
    const reason = caseReason(erroredCase(message));
    expect(reason).toBe(message); // whole thing, verbatim
    expect(reason?.endsWith("at the very end")).toBe(true);
  });

  it("still bounds a pathological message so the steps jsonb cannot explode, marking the cut with an ellipsis", () => {
    const reason = caseReason(erroredCase("y".repeat(5000)));
    expect(reason).toHaveLength(2001); // 2000 kept + the ellipsis marker
    expect(reason?.endsWith("…")).toBe(true);
  });

  it("returns undefined when there is no error event or pass:false detail", () => {
    expect(
      caseReason({
        caseId: "c1",
        harness: "h@1",
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
      }),
    ).toBeUndefined();
  });
});

describe("judge-metric ownership (one predicate for both scoring paths)", () => {
  const measured: Score = { graderId: "judge", metric: "judge:j", value: 1, pass: true };
  const placeholder: Score = {
    graderId: "judge",
    metric: "judge:j",
    status: "unmeasured",
    reason: "grader_error",
    retryable: true,
  };
  // A pre-status row only ever exists as persisted data, so it enters through the decoder that owns the
  // legacy vocabulary — the single place any of it lives now.
  const legacySentinel: Score = ScoreSchema.parse({
    graderId: "judge",
    metric: "judge:j",
    value: 0,
    detail: "[grader-error] transport died",
  });
  const criterion: Score = { graderId: "judge", metric: "judge:j:accuracy", value: 0.8, pass: true };
  const otherJudge: Score = { graderId: "judge", metric: "judge:other", value: 1, pass: true };
  const grader: Score = { graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true };

  it("hasMeasuredJudgeVerdict — a measured top-level verdict counts, placeholders (modern or legacy) do not", () => {
    expect(hasMeasuredJudgeVerdict({ scores: [measured] }, "j")).toBe(true);
    expect(hasMeasuredJudgeVerdict({ scores: [placeholder] }, "j")).toBe(false);
    expect(hasMeasuredJudgeVerdict({ scores: [legacySentinel] }, "j")).toBe(false);
    // a criterion child alone is diagnostic, never the verdict
    expect(hasMeasuredJudgeVerdict({ scores: [criterion] }, "j")).toBe(false);
  });

  it("stripJudgeScores — removes the judge's verdict, criterion children AND placeholders; keeps everything else", () => {
    const scores = [measured, placeholder, criterion, otherJudge, grader];
    const stripped = stripJudgeScores(scores, [{ id: "j" }]);
    // Regression: the exact-name strip (judge:<id> only) left stale criterion rows to compound on every pass.
    expect(stripped).toEqual([otherJudge, grader]);
  });

  it("isJudgeMetricOf — prefix family, never a different judge sharing a prefix string", () => {
    expect(isJudgeMetricOf("judge:j", "j")).toBe(true);
    expect(isJudgeMetricOf("judge:j:accuracy", "j")).toBe(true);
    expect(isJudgeMetricOf("judge:jj", "j")).toBe(false); // judge "jj" is not judge "j"
    expect(isJudgeMetricOf("tests_pass", "j")).toBe(false);
  });
});
