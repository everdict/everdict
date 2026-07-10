import { type AgentJob, BadRequestError, type CaseResult, type Suite, UpstreamError } from "@everdict/contracts";
import { caseTrialStats, caseVerdict } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { runSuite } from "./run-suite.js";

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

  it("respects the concurrency cap — never runs more than `concurrency` cases at once", async () => {
    // Given: a suite whose dispatch tracks in-flight count against the cap
    const suite: Suite = {
      id: "wide",
      harness: { id: "h" },
      cases: Array.from({ length: 6 }, (_, i) => ({
        id: `c${i}`,
        env: { kind: "prompt" as const },
        task: "t",
        graders: [],
        timeoutSec: 1,
        tags: [],
      })),
    };
    let inFlight = 0;
    let peak = 0;
    const dispatch = async (job: AgentJob): Promise<CaseResult> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // hold the slot so overlap is observable
      inFlight--;
      return caseResult(job.evalCase.id, "h@1", true, 1);
    };
    // When: running with a cap of 2
    const sc = await runSuite(suite, "1", dispatch, { concurrency: 2 });
    // Then: all cases complete and the observed peak never exceeded the cap
    expect(sc.results).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
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
    expect(failed?.scores).toEqual([
      { graderId: "dispatch", metric: "error", value: 0, pass: false, detail: "[infra] boom" },
    ]);
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

// Transient dispatch retry — a throw is an infra signal and gets retried; a failing RESULT is an eval outcome and never is.
describe("runSuite transient retry", () => {
  const suite: Suite = {
    id: "s",
    harness: { id: "h" },
    cases: [{ id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
  };
  const okResult: CaseResult = {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [{ graderId: "g", metric: "m", value: 0, pass: false }], // failing SCORE — must not trigger a retry
  };

  it("retries a throwing dispatch and succeeds on a later attempt", async () => {
    let calls = 0;
    const dispatch = async (): Promise<CaseResult> => {
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
    const dispatch = async (): Promise<CaseResult> => {
      calls++;
      throw new Error("still down");
    };
    const sc = await runSuite(suite, "1", dispatch, { retries: 2, retryBackoffMs: 1 });
    expect(calls).toBe(3);
    expect(sc.results[0]?.scores[0]).toMatchObject({ graderId: "dispatch", pass: false });
  });

  it("a result with failing scores is a legitimate outcome — exactly one dispatch, no retry", async () => {
    let calls = 0;
    const dispatch = async (): Promise<CaseResult> => {
      calls++;
      return okResult;
    };
    await runSuite(suite, "1", dispatch, { retries: 3, retryBackoffMs: 1 });
    expect(calls).toBe(1);
  });
});

// Class-aware retry — only retryable-classified failures earn attempts; the classified failure rides on the result.
describe("runSuite failure classification", () => {
  const suite: Suite = {
    id: "s",
    harness: { id: "h" },
    cases: [{ id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
  };

  it("a config-class failure (missing secret) is NOT retried — retrying changes nothing", async () => {
    let calls = 0;
    const dispatch = async (): Promise<CaseResult> => {
      calls++;
      throw new BadRequestError("BAD_REQUEST", {}, "secret OPENAI_API_KEY is not set");
    };
    const sc = await runSuite(suite, "1", dispatch, { retries: 3, retryBackoffMs: 1 });
    expect(calls).toBe(1);
    expect(sc.results[0]?.failure).toMatchObject({ class: "config", retryable: false, stage: "dispatch" });
  });

  it("a retryable infra failure keeps its classification on the frozen result after attempts run out", async () => {
    const dispatch = async (): Promise<CaseResult> => {
      throw new UpstreamError("UPSTREAM_ERROR", {}, "placement blip");
    };
    const sc = await runSuite(suite, "1", dispatch, { retries: 1, retryBackoffMs: 1 });
    expect(sc.results[0]?.failure).toMatchObject({ class: "infra", code: "UPSTREAM_ERROR", retryable: true });
    expect(String(sc.results[0]?.scores[0]?.detail)).toContain("[infra]");
  });
});

// N-trial fan-out — run each case multiple times so the scorecard can compute pass@k / flakiness.
describe("runSuite N-trial fan-out", () => {
  it("runs each case N times, stamping a distinct trial index on every job and result", async () => {
    // Given: a dispatch that records the jobs it sees
    const seen: AgentJob[] = [];
    const dispatch = async (job: AgentJob): Promise<CaseResult> => {
      seen.push(job);
      return caseResult(job.evalCase.id, `${job.harness.id}@${job.harness.version}`, true, 1);
    };
    // When: running 3 trials of a 2-case suite
    const sc = await runSuite(SUITE, "1.0.0", dispatch, { concurrency: 4, trials: 3 });
    // Then: 2 cases × 3 trials = 6 dispatches, each case's trials indexed 0..2, and every result carries its trial
    expect(seen).toHaveLength(6);
    expect(
      seen
        .filter((j) => j.evalCase.id === "a")
        .map((j) => j.trial)
        .sort(),
    ).toEqual([0, 1, 2]);
    const aResults = sc.results.filter((r) => r.caseId === "a");
    expect(aResults).toHaveLength(3);
    expect(aResults.map((r) => r.trial).sort()).toEqual([0, 1, 2]);
  });

  it("defaults to 1 trial and leaves the trial index unset (single-run shape unchanged)", async () => {
    const seen: AgentJob[] = [];
    const dispatch = async (job: AgentJob): Promise<CaseResult> => {
      seen.push(job);
      return caseResult(job.evalCase.id, `${job.harness.id}@${job.harness.version}`, true, 1);
    };
    const sc = await runSuite(SUITE, "1.0.0", dispatch);
    expect(seen.every((j) => j.trial === undefined)).toBe(true);
    expect(sc.results.every((r) => r.trial === undefined)).toBe(true);
  });

  it("isolates a throwing trial — the other trials of the same case still run and feed pass@k", async () => {
    // Given: case a's second trial throws, every other trial passes
    const dispatch = async (job: AgentJob): Promise<CaseResult> => {
      if (job.evalCase.id === "a" && job.trial === 1) throw new Error("flake");
      return caseResult(job.evalCase.id, `${job.harness.id}@${job.harness.version}`, true, 1);
    };
    // When: running 3 trials per case
    const sc = await runSuite(SUITE, "1.0.0", dispatch, { concurrency: 4, trials: 3 });
    // Then: case a still has all 3 trials, one the isolated dispatch failure, and the trial math sees 2/3 (flaky)
    const aResults = sc.results.filter((r) => r.caseId === "a").sort((x, y) => (x.trial ?? 0) - (y.trial ?? 0));
    expect(aResults.map((r) => r.trial)).toEqual([0, 1, 2]);
    expect(aResults[1]?.scores[0]).toMatchObject({ graderId: "dispatch", pass: false });
    expect(caseTrialStats("a", aResults)).toMatchObject({ trials: 3, passes: 2, flaky: true });
  });
});
