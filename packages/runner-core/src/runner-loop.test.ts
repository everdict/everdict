import { type AgentJob, type CaseResult, InternalError } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { runLeaseWorkers } from "./runner-loop.js";

const evalCase: AgentJob["evalCase"] = {
  id: "c",
  env: { kind: "repo", source: { files: {} } },
  task: "do",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

const job = (id: string): AgentJob => ({
  evalCase: { ...evalCase, id },
  harness: { id: "scripted", version: "1.0.0" },
});

// A fake MCP surface — lease_job does a synchronous shift from the queue (atomic), submit/fail record. runJob measures concurrent in-flight.
function harness(jobs: AgentJob[]) {
  const queue = jobs.map((j, i) => ({ jobId: `j${i}`, job: j }));
  const submitted: string[] = [];
  const failed: string[] = [];
  let inFlight = 0;
  let peak = 0;
  let runCalls = 0;
  let stop = false;
  const settle = () => {
    if (submitted.length + failed.length >= jobs.length) stop = true;
  };

  const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (name === "lease_job") {
      const next = queue.shift(); // synchronous shift — JS is single-threaded, so concurrent leases can't take the same job twice
      settle();
      return next ?? {};
    }
    if (name === "submit_job_result") {
      submitted.push(String(args.jobId));
      settle();
      return {};
    }
    if (name === "fail_job") {
      failed.push(String(args.jobId));
      settle();
      return {};
    }
    return {}; // heartbeat_job etc.
  };

  const runJob = async (j: AgentJob): Promise<CaseResult> => {
    runCalls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10)); // hold briefly so parallelism accumulates
    inFlight--;
    return {
      caseId: j.evalCase.id,
      harness: "scripted@1.0.0",
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
    };
  };

  return {
    callJson,
    runJob,
    submitted,
    failed,
    peak: () => peak,
    runCalls: () => runCalls,
    shouldStop: () => stop,
  };
}

const opts = (maxConcurrent: number, shouldStop: () => boolean) => ({
  maxConcurrent,
  waitMs: 0,
  heartbeatMs: 10_000,
  pollMs: 0,
  capabilities: ["repo"],
  shouldStop,
});

describe("runLeaseWorkers — case-level parallelism (maxConcurrent)", () => {
  it("maxConcurrent workers pick up jobs concurrently and run them in parallel (3 jobs + 3 workers → 3 concurrent)", async () => {
    const h = harness([job("a"), job("b"), job("c")]);
    await runLeaseWorkers(
      {
        callJson: h.callJson,
        runJob: h.runJob,
        sleep: () => new Promise((r) => setTimeout(r, 0)),
        setHeartbeat: () => () => {},
      },
      opts(3, h.shouldStop),
    );
    expect(h.peak()).toBe(3); // three in-flight at once
    expect(h.runCalls()).toBe(3);
    expect([...h.submitted].sort()).toEqual(["j0", "j1", "j2"]); // each job exactly once (no duplicate lease)
    expect(h.failed).toEqual([]);
  });

  it("maxConcurrent=1 → serial execution one at a time (concurrency 1)", async () => {
    const h = harness([job("a"), job("b"), job("c")]);
    await runLeaseWorkers(
      {
        callJson: h.callJson,
        runJob: h.runJob,
        sleep: () => new Promise((r) => setTimeout(r, 0)),
        setHeartbeat: () => () => {},
      },
      opts(1, h.shouldStop),
    );
    expect(h.peak()).toBe(1);
    expect(h.runCalls()).toBe(3);
    expect([...h.submitted].sort()).toEqual(["j0", "j1", "j2"]);
  });

  it("even with more workers than jobs, each job runs exactly once (atomic lease)", async () => {
    const h = harness([job("a"), job("b")]);
    await runLeaseWorkers(
      {
        callJson: h.callJson,
        runJob: h.runJob,
        sleep: () => new Promise((r) => setTimeout(r, 0)),
        setHeartbeat: () => () => {},
      },
      opts(5, h.shouldStop),
    );
    expect(h.runCalls()).toBe(2);
    expect([...h.submitted].sort()).toEqual(["j0", "j1"]);
  });

  it("malformed job → reply fail_job (don't run)", async () => {
    const submitted: string[] = [];
    const failed: string[] = [];
    let leased = false;
    let stop = false;
    const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (name === "lease_job") {
        if (leased) return {};
        leased = true;
        return { jobId: "bad", job: { not: "an AgentJob" } }; // schema violation
      }
      if (name === "submit_job_result") {
        submitted.push(String(args.jobId));
        return {};
      }
      if (name === "fail_job") {
        failed.push(String(args.jobId));
        stop = true;
        return {};
      }
      return {};
    };
    let ran = false;
    await runLeaseWorkers(
      {
        callJson,
        runJob: async () => {
          ran = true;
          return { caseId: "x", harness: "h", trace: [], snapshot: { kind: "prompt", output: "" }, scores: [] };
        },
        sleep: () => new Promise((r) => setTimeout(r, 0)),
        setHeartbeat: () => () => {},
      },
      opts(1, () => stop),
    );
    expect(failed).toEqual(["bad"]);
    expect(submitted).toEqual([]);
    expect(ran).toBe(false); // a malformed job isn't run
  });
});

// Classified-failure parity with the agent sentinel — the self-hosted path has no sentinel, so a runJob throw
// must settle as a CLASSIFIED failed CaseResult (stage × class preserved), not evaporate into a bare fail_job.
describe("runLeaseWorkers — classified failure submission", () => {
  it("a runJob throw submits a failed CaseResult with stage/class; fail_job is not used", async () => {
    const results: Array<Record<string, unknown>> = [];
    const failed: string[] = [];
    let stop = false;
    const queue: Array<Record<string, unknown>> = [
      {
        jobId: "j1",
        job: {
          harness: { id: "h", version: "1" },
          evalCase: { id: "c1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] },
        },
      },
    ];
    const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (name === "lease_job") {
        const next = queue.shift();
        if (!next) stop = true;
        return next ?? {};
      }
      if (name === "submit_job_result") {
        results.push(args.result as Record<string, unknown>);
        stop = true;
        return {};
      }
      if (name === "fail_job") {
        failed.push(String(args.jobId));
        stop = true;
        return {};
      }
      return {};
    };
    await runLeaseWorkers(
      {
        callJson,
        runJob: async () => {
          throw new InternalError("HARNESS_INSTALL_FAILED", {}, "pip exploded");
        },
        log: () => {},
      },
      { maxConcurrent: 1, waitMs: 0, heartbeatMs: 10_000, pollMs: 0, capabilities: ["repo"], shouldStop: () => stop },
    );
    expect(failed).toEqual([]); // no bare fail_job
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      caseId: "c1",
      failure: { stage: "install", class: "harness", code: "HARNESS_INSTALL_FAILED", retryable: false },
    });
  });
});
