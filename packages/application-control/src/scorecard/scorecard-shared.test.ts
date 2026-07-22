import type { CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { caseReason } from "./scorecard-shared.js";

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
