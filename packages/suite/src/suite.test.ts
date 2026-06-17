import type { AgentJob, CaseResult, Scorecard, Suite } from "@assay/core";
import { describe, expect, it } from "vitest";
import { runSuite } from "./run-suite.js";
import { diffScorecards, summarizeScorecard } from "./scorecard.js";

function caseResult(caseId: string, harness: string, pass: boolean, steps: number): CaseResult {
  return {
    caseId,
    harness,
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [
      { graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass },
      { graderId: "steps", metric: "tool_calls", value: steps },
    ],
  };
}

const SUITE: Suite = {
  id: "s1",
  harness: { id: "claude-code" },
  cases: [
    { id: "a", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
    { id: "b", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
  ],
};

describe("runSuite", () => {
  it("케이스마다 하니스 버전을 붙여 dispatch 하고 Scorecard 로 모은다", async () => {
    const seen: AgentJob[] = [];
    const dispatch = async (job: AgentJob): Promise<CaseResult> => {
      seen.push(job);
      return caseResult(job.evalCase.id, `${job.harness.id}@${job.harness.version}`, true, 3);
    };
    const sc = await runSuite(SUITE, "1.0.0", dispatch, { concurrency: 2 });
    expect(sc.harness).toBe("claude-code@1.0.0");
    expect(sc.results.map((r) => r.caseId).sort()).toEqual(["a", "b"]);
    expect(seen.every((j) => j.harness.version === "1.0.0")).toBe(true);
  });
});

describe("summarizeScorecard", () => {
  it("메트릭별 통과율/평균을 집계한다", () => {
    const sc: Scorecard = {
      suiteId: "s1",
      harness: "h@1",
      results: [caseResult("a", "h@1", true, 2), caseResult("b", "h@1", false, 4)],
    };
    const summary = summarizeScorecard(sc);
    const tests = summary.find((s) => s.metric === "tests_pass");
    expect(tests?.passRate).toBe(0.5);
    const steps = summary.find((s) => s.metric === "tool_calls");
    expect(steps?.mean).toBe(3);
  });
});

describe("diffScorecards", () => {
  it("pass 전이로 회귀/개선을 잡고 메트릭 delta 를 낸다", () => {
    const base: Scorecard = {
      suiteId: "s1",
      harness: "h@1",
      results: [caseResult("a", "h@1", true, 2), caseResult("b", "h@1", false, 5)],
    };
    const cand: Scorecard = {
      suiteId: "s1",
      harness: "h@2",
      results: [caseResult("a", "h@2", false, 3), caseResult("b", "h@2", true, 4)],
    };
    const diff = diffScorecards(base, cand);
    expect(diff.regressions.map((d) => d.caseId)).toEqual(["a"]); // a: pass→fail
    expect(diff.improvements.map((d) => d.caseId)).toEqual(["b"]); // b: fail→pass
    const steps = diff.metrics.find((m) => m.metric === "tool_calls");
    expect(steps?.baselineMean).toBe(3.5);
    expect(steps?.candidateMean).toBe(3.5);
  });
});
