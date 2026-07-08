import type { AgentJob, CaseResult, Scorecard, Suite } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { runSuite } from "./run-suite.js";
import { caseVerdict, diffScorecards, scorecardPassRate, summarizeScorecard } from "./scorecard.js";

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
  it("dispatches each case with the harness version attached and collects them into a Scorecard", async () => {
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

  it("does not stop the batch when one case's dispatch throws and records it as a failed CaseResult", async () => {
    // Given: a dispatch where case a throws and b succeeds
    const dispatch = async (job: AgentJob): Promise<CaseResult> => {
      if (job.evalCase.id === "a") throw new Error("boom");
      return caseResult(job.evalCase.id, `${job.harness.id}@${job.harness.version}`, true, 3);
    };
    // When: running the suite
    const sc = await runSuite(SUITE, "1.0.0", dispatch, { concurrency: 2 });
    // Then: both cases have results, and a is captured with an error trace + pass:false
    expect(sc.results.map((r) => r.caseId).sort()).toEqual(["a", "b"]);
    const failed = sc.results.find((r) => r.caseId === "a");
    expect(failed?.harness).toBe("claude-code@1.0.0");
    expect(failed?.trace).toEqual([{ t: 0, kind: "error", message: "boom" }]);
    expect(failed?.scores).toEqual([{ graderId: "dispatch", metric: "error", value: 0, pass: false, detail: "boom" }]);
    expect(caseVerdict(failed ?? { scores: [] })).toBe(false);
    // the successful case aggregates normally
    expect(caseVerdict(sc.results.find((r) => r.caseId === "b") ?? { scores: [] })).toBe(true);
  });

  it("does not launch remaining cases after signal abort (cooperative cancellation — already-launched cases complete and are included in the results)", async () => {
    // Given: a batch that aborts while the first case is being dispatched (serial — concurrency 1 fixes the order)
    const controller = new AbortController();
    const dispatched: string[] = [];
    const dispatch = async (job: AgentJob): Promise<CaseResult> => {
      dispatched.push(job.evalCase.id);
      controller.abort(); // scenario where supersede happens while the first case runs
      return caseResult(job.evalCase.id, `${job.harness.id}@${job.harness.version}`, true, 1);
    };
    // When: running with the abort signal
    const sc = await runSuite(SUITE, "1.0.0", dispatch, { concurrency: 1, signal: controller.signal });
    // Then: the second case is not launched, and only the completed first case remains in the results (no empty slots)
    expect(dispatched).toEqual(["a"]);
    expect(sc.results.map((r) => r.caseId)).toEqual(["a"]);
  });
});

describe("summarizeScorecard", () => {
  it("aggregates pass rate/mean per metric", () => {
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
  it("catches regressions/improvements by pass transitions and produces metric deltas", () => {
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

describe("caseVerdict (authority-based)", () => {
  const sc = (scores: { metric: string; pass?: boolean; value?: number }[]): { scores: never } =>
    ({
      scores: scores.map((s) => ({ graderId: s.metric, metric: s.metric, value: s.value ?? 0, pass: s.pass })),
    }) as never;

  it("ground-truth (state) beats the judge — OSWorld file save: state PASS + judge FAIL → PASS", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "state", pass: true },
          { metric: "judge", pass: false },
        ]),
      ),
    ).toBe(true);
  });
  it("objective (answer_match) takes precedence over the judge", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "answer_match", pass: false },
          { metric: "judge", pass: true },
        ]),
      ),
    ).toBe(false);
  });
  it("with multiple objective graders, all must pass", () => {
    expect(
      caseVerdict(
        sc([
          { metric: "url_matches", pass: true },
          { metric: "dom_contains", pass: false },
        ]),
      ),
    ).toBe(false);
  });
  it("with no objective/ground-truth, the judge decides", () => {
    expect(caseVerdict(sc([{ metric: "judge", pass: true }, { metric: "tool_calls" }]))).toBe(true);
  });
  it("undefined when there is no pass-deciding grader", () => {
    expect(caseVerdict(sc([{ metric: "tool_calls", value: 5 }]))).toBeUndefined();
  });
  it("scorecardPassRate: authority-based case pass rate", () => {
    const card: Scorecard = {
      suiteId: "s",
      harness: "h",
      results: [
        caseResult("a", "h", true, 3), // tests_pass PASS → PASS
        {
          ...caseResult("b", "h", true, 3),
          scores: [
            { graderId: "state", metric: "state", value: 1, pass: true },
            { graderId: "judge", metric: "judge", value: 0, pass: false },
          ],
        }, // state PASS / judge FAIL → PASS
      ],
    };
    expect(scorecardPassRate(card)).toEqual({ pass: 2, total: 2, rate: 1 });
  });
});

// Transient dispatch retry — a throw is an infra signal and gets retried; a failing RESULT is an eval outcome and never is.
describe("runSuite transient retry", () => {
  const suite = {
    id: "s",
    harness: { id: "h" },
    cases: [{ id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
  };
  const okResult = {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt" as const, output: "" },
    scores: [{ graderId: "g", metric: "m", value: 0, pass: false }], // failing SCORE — must not trigger a retry
  };

  it("retries a throwing dispatch and succeeds on a later attempt", async () => {
    let calls = 0;
    const dispatch = async () => {
      calls++;
      if (calls < 3) throw new Error("placement blip");
      return okResult;
    };
    const sc = await runSuite(suite, "1", dispatch, { retries: 2, retryBackoffMs: 1 });
    expect(calls).toBe(3);
    expect(sc.results[0]?.caseId).toBe("c1");
    expect(sc.results[0]?.scores.some((s) => s.graderId === "dispatch")).toBe(false);
  });

  it("freezes into a dispatch-error result once attempts are exhausted", async () => {
    let calls = 0;
    const dispatch = async () => {
      calls++;
      throw new Error("still down");
    };
    const sc = await runSuite(suite, "1", dispatch, { retries: 2, retryBackoffMs: 1 });
    expect(calls).toBe(3);
    expect(sc.results[0]?.scores[0]).toMatchObject({ graderId: "dispatch", pass: false });
  });

  it("a result with failing scores is a legitimate outcome — exactly one dispatch, no retry", async () => {
    let calls = 0;
    const dispatch = async () => {
      calls++;
      return okResult;
    };
    await runSuite(suite, "1", dispatch, { retries: 3, retryBackoffMs: 1 });
    expect(calls).toBe(1);
  });
});
