import { type AgentJob, type CaseResult, InternalError, RUNNER_PROTOCOL_VERSION } from "@everdict/contracts";
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

  it("reports its live status on every lease — a failed job becomes an error status the roster can show (diagnosability)", async () => {
    const leaseStatuses: Array<{ text: unknown; level: unknown }> = [];
    let stop = false;
    const queue = [{ jobId: "j0", job: job("boom") }];
    const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (name === "lease_job") {
        leaseStatuses.push({ text: args.status, level: args.statusLevel });
        if (leaseStatuses.length >= 2) stop = true; // captured the post-failure status → wind down
        return queue.shift() ?? {};
      }
      return {}; // submit_job_result / heartbeat_job accepted
    };
    const runJob = async (): Promise<CaseResult> => {
      throw new Error("docker daemon not running");
    };
    await runLeaseWorkers(
      { callJson, runJob, setHeartbeat: () => () => {}, sleep: async () => {} },
      opts(1, () => stop),
    );
    // the first lease carries a benign status; after the job fails, the NEXT lease carries an error status naming why
    const err = leaseStatuses.find((s) => s.level === "error");
    expect(err).toBeTruthy();
    expect(String(err?.text)).toMatch(/last job failed.*docker daemon not running/i);
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

  it("a harnessSpec discriminator mismatch (e.g. target.delivery.mode) → the fail message hints at a version skew", async () => {
    const failMessages: string[] = [];
    let leased = false;
    let stop = false;
    const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (name === "lease_job") {
        if (leased) return {};
        leased = true;
        // A service harnessSpec whose target.delivery.mode is not reference|sentinel|egress — the exact shape a newer
        // runner rejects when the control plane embedded a spec its own (older/looser) schema accepted.
        return {
          jobId: "skew",
          job: {
            harnessSpec: {
              kind: "service",
              target: { kind: "browser", engine: "chromium", observe: [], delivery: { mode: "bogus" } },
            },
          },
        };
      }
      if (name === "fail_job") {
        failMessages.push(String(args.message));
        stop = true;
        return {};
      }
      return {};
    };
    await runLeaseWorkers(
      {
        callJson,
        runJob: async () => ({
          caseId: "x",
          harness: "h",
          trace: [],
          snapshot: { kind: "prompt", output: "" },
          scores: [],
        }),
        sleep: () => new Promise((r) => setTimeout(r, 0)),
        setHeartbeat: () => () => {},
      },
      opts(1, () => stop),
    );
    expect(failMessages).toHaveLength(1);
    expect(failMessages[0]).toContain("malformed job:");
    expect(failMessages[0]).toContain("different everdict versions"); // the version-skew hint, not just an opaque dump
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

// Lease cancellation — the control plane piggybacks a cancel decision on the heartbeat reply; the worker aborts the
// in-flight run (which frees the runtime mid-case) and settles it back so the batch isn't left hanging.
describe("runLeaseWorkers — heartbeat-delivered cancellation", () => {
  it("aborts the in-flight run when the heartbeat asks to cancel, then submits the classified result", async () => {
    let aborted = false;
    const submitted: string[] = [];
    let stop = false;
    const queue: Array<Record<string, unknown>> = [{ jobId: "j1", job: job("c1") }];
    const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (name === "lease_job") {
        const next = queue.shift();
        if (!next) stop = true;
        return next ?? {};
      }
      if (name === "submit_job_result") {
        submitted.push(String(args.jobId));
        stop = true;
        return {};
      }
      if (name === "fail_job") {
        stop = true;
        return {};
      }
      return {};
    };
    // A hanging run that ends only when its cancellation signal aborts.
    const runJob = (_j: AgentJob, o?: { signal?: AbortSignal }): Promise<CaseResult> =>
      new Promise<CaseResult>((_, reject) => {
        o?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("cancelled")); // any throw — the loop classifies it into a failed CaseResult
          },
          { once: true },
        );
      });
    // The heartbeat requests a cancel on the next tick (as if the control plane returned {cancelled:true}).
    const setHeartbeat = (_jobId: string, onCancel: () => void) => {
      const t = setTimeout(onCancel, 0);
      return () => clearTimeout(t);
    };
    await runLeaseWorkers(
      { callJson, runJob, setHeartbeat, sleep: () => new Promise((r) => setTimeout(r, 0)) },
      opts(1, () => stop),
    );
    expect(aborted).toBe(true); // the cancel signal reached the run
    expect(submitted).toEqual(["j1"]); // the classified (interrupted) result was submitted so the batch settles
  });
});

describe("runLeaseWorkers — version self-report + update-required signal", () => {
  it("reports the runner version + protocol on every lease", async () => {
    let stop = false;
    const leaseArgs: Array<Record<string, unknown>> = [];
    const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (name === "lease_job") {
        leaseArgs.push(args);
        stop = true; // one poll is enough
        return { job: null };
      }
      return {};
    };
    await runLeaseWorkers(
      { callJson, runJob: async () => ({}) as CaseResult, sleep: () => new Promise((r) => setTimeout(r, 0)) },
      { ...opts(1, () => stop), version: "9.9.9" },
    );
    expect(leaseArgs[0]).toMatchObject({ version: "9.9.9", protocol: RUNNER_PROTOCOL_VERSION });
  });

  it("fires onUpdateRequired exactly once when the control plane replies updateRequired, even across many polls/workers", async () => {
    let polls = 0;
    let stop = false;
    const updates: Array<{ serverProtocol?: number }> = [];
    const callJson = async (name: string): Promise<Record<string, unknown>> => {
      if (name === "lease_job") {
        polls++;
        if (polls >= 6) stop = true;
        // The server keeps flagging the runner as behind on every reply — the loop must still signal only once.
        return { job: null, updateRequired: true, serverProtocol: RUNNER_PROTOCOL_VERSION + 1 };
      }
      return {};
    };
    await runLeaseWorkers(
      {
        callJson,
        runJob: async () => ({}) as CaseResult,
        sleep: () => new Promise((r) => setTimeout(r, 0)),
        onUpdateRequired: (info) => updates.push(info),
      },
      opts(2, () => stop), // 2 workers both see updateRequired
    );
    expect(updates).toEqual([{ serverProtocol: RUNNER_PROTOCOL_VERSION + 1 }]); // once, not per-poll/per-worker
  });

  it("does not fire onUpdateRequired when the runner is up to date", async () => {
    let stop = false;
    let fired = false;
    const callJson = async (name: string): Promise<Record<string, unknown>> => {
      if (name === "lease_job") {
        stop = true;
        return { job: null }; // no updateRequired
      }
      return {};
    };
    await runLeaseWorkers(
      {
        callJson,
        runJob: async () => ({}) as CaseResult,
        sleep: () => new Promise((r) => setTimeout(r, 0)),
        onUpdateRequired: () => {
          fired = true;
        },
      },
      opts(1, () => stop),
    );
    expect(fired).toBe(false);
  });
});
