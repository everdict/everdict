import type { CaseResult, JudgeSpec, Score } from "@everdict/contracts";
import { ScoreSchema } from "@everdict/contracts";
import { caseReason, hasMeasuredJudgeVerdict, isJudgeMetricOf, stripJudgeScores } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { RubricRegistry } from "../ports/rubric-registry.js";
import { sealJudgeClosure } from "./scorecard-plan.js";

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

describe("sealJudgeClosure — the whole closure, one sealer (H8)", () => {
  const modelJudge = (rubric: string | { id: string; version: string }): JudgeSpec => ({
    kind: "model",
    id: "quality",
    version: "3.0.0",
    provider: "anthropic",
    model: "claude-opus-4-8",
    rubric,
    inputs: ["trace"],
    tags: [],
  });
  const judgesOf = (spec: JudgeSpec): JudgeRegistry => ({ get: async () => spec }) as unknown as JudgeRegistry;
  const rubricsAt = (version: string, onHit?: () => void): RubricRegistry =>
    ({
      get: async () => {
        onHit?.();
        return { version };
      },
    }) as unknown as RubricRegistry;

  it("pins a latest rubric ref to its concrete version; an explicit pin seals verbatim without a registry hit", async () => {
    let hits = 0;
    const rubrics = rubricsAt("2.0.0", () => hits++);
    const latest = await sealJudgeClosure(
      { judges: judgesOf(modelJudge({ id: "style", version: "latest" })), rubrics },
      "acme",
      [{ id: "quality", version: "3.0.0" }],
    );
    expect(latest[0]?.rubric).toBe("style@2.0.0");
    expect(hits).toBe(1);
    const pinned = await sealJudgeClosure(
      { judges: judgesOf(modelJudge({ id: "style", version: "1.0.0" })), rubrics },
      "acme",
      [{ id: "quality", version: "3.0.0" }],
    );
    expect(pinned[0]?.rubric).toBe("style@1.0.0"); // registry versions are immutable — the pin IS the identity
    expect(hits).toBe(1); // no second hit
  });

  it("seals the honest 'unresolved' sentinel when no registry can answer a latest ref — and nothing for inline text", async () => {
    const unresolvable = await sealJudgeClosure(
      { judges: judgesOf(modelJudge({ id: "style", version: "latest" })) },
      "acme",
      [{ id: "quality", version: "3.0.0" }],
    );
    expect(unresolvable[0]?.rubric).toBe("unresolved");
    const inline = await sealJudgeClosure({ judges: judgesOf(modelJudge("is it good?")) }, "acme", [
      { id: "quality", version: "3.0.0" },
    ]);
    expect(inline[0]?.rubric).toBeUndefined(); // inline text lives inside specDigest — nothing to resolve
  });

  it("pins a harness judge's delegated agent the same way", async () => {
    const harnessJudge: JudgeSpec = {
      kind: "harness",
      id: "agent-judge",
      version: "1.0.0",
      harness: { id: "grader-agent", version: "latest" },
      tags: [],
    };
    const harnesses = { get: async () => ({ version: "4.0.0" }) } as unknown as HarnessInstanceRegistry;
    const sealed = await sealJudgeClosure({ judges: judgesOf(harnessJudge), harnesses }, "acme", [
      { id: "agent-judge", version: "1.0.0" },
    ]);
    expect(sealed[0]?.harness).toBe("grader-agent@4.0.0");
    expect(sealed[0]?.model).toBeUndefined(); // no binding — the delegate judges
  });
});
