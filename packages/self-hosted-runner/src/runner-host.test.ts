import type { AgentJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { RunnerHost, type RunnerHostStatus, type RunnerJobDone } from "./runner-host.js";
import type { RunnerClient } from "./runner-session.js";

const evalCase: AgentJob["evalCase"] = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "do",
  graders: [],
  timeoutSec: 60,
  tags: [],
};
const JOB: AgentJob = { evalCase, harness: { id: "h", version: "1" } };
const RESULT: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
};

// A call-scripted fake session — one job on the first lease, empty responses after.
function fakeClient(calls: Array<{ name: string; args: Record<string, unknown> }>): RunnerClient {
  let leased = false;
  return {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "lease_job" && !leased) {
        leased = true;
        return { text: JSON.stringify({ jobId: "j1", job: JOB }), isError: false };
      }
      if (name === "lease_job") return { text: JSON.stringify({}), isError: false };
      return { text: JSON.stringify({ ok: true }), isError: false };
    },
    async close() {},
  };
}

describe("RunnerHost", () => {
  it("emits the state transitions start→job running→reply→idle→stop(off) as events", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const statuses: RunnerHostStatus[] = [];
    const done: RunnerJobDone[] = [];
    let resolveRun: (() => void) | undefined;
    const runStarted = new Promise<void>((r) => {
      resolveRun = r;
    });
    const host = new RunnerHost({
      apiUrl: "http://localhost:8787",
      token: "rnr_x",
      capabilities: ["repo"],
      connect: async () => fakeClient(calls),
      runJob: async () => {
        resolveRun?.();
        return RESULT;
      },
      onStatus: (s) => statuses.push(s),
      onJobDone: (d) => done.push(d),
      sleep: async () => {},
      waitMs: 10,
      pollMs: 1,
    });

    expect(host.status().state).toBe("off");
    await host.start();
    await runStarted;
    await host.stop();

    expect(statuses.map((s) => s.state)).toContain("running");
    expect(statuses.at(-1)?.state).toBe("off");
    // The job result was replied — submit_job_result(j1, RESULT).
    const submit = calls.find((c) => c.name === "submit_job_result");
    expect(submit?.args).toMatchObject({ jobId: "j1", result: RESULT });
    // A completion notice (success) fired — the basis for the OS notification.
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ result: RESULT });
    expect(done[0]?.error).toBeUndefined();
  });

  it("start is idempotent (no duplicate loop), and capabilities are carried in the status", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const host = new RunnerHost({
      apiUrl: "http://localhost:8787",
      token: "rnr_x",
      capabilities: ["repo", "docker"],
      connect: async () => fakeClient(calls),
      runJob: async () => RESULT,
      sleep: async () => {},
      waitMs: 10,
      pollMs: 1,
    });
    await host.start();
    await host.start(); // idempotent
    expect(host.status().capabilities).toEqual(["repo", "docker"]);
    await host.stop();
    expect(host.status().state).toBe("off");
  });

  it("restart tears down the loop and resumes leasing on a fresh session (recovers an offline runner)", async () => {
    // connect() opens a session lazily on the first lease; restart must open a NEW one (not reuse the torn-down session).
    // lease_job parks briefly each poll so the idle loop can't busy-spin the microtask queue (real timers, no sleep override).
    let connectCount = 0;
    const idleSession = (): RunnerClient => ({
      async callTool(name) {
        if (name === "lease_job") {
          await new Promise((r) => setTimeout(r, 5));
          return { text: JSON.stringify({}), isError: false };
        }
        return { text: JSON.stringify({ ok: true }), isError: false };
      },
      async close() {},
    });
    const host = new RunnerHost({
      apiUrl: "http://localhost:8787",
      token: "rnr_x",
      capabilities: ["repo"],
      connect: async () => {
        connectCount++;
        return idleSession();
      },
      runJob: async () => RESULT,
      waitMs: 10,
      pollMs: 1,
    });

    await host.start();
    await vi.waitFor(() => expect(connectCount).toBe(1)); // the loop opened its session
    expect(host.status().state).not.toBe("off");
    await host.restart();
    // A brand-new session was opened (the first was torn down) → the runner resumes leasing → lastSeenAt refreshes again.
    await vi.waitFor(() => expect(connectCount).toBe(2));
    expect(host.status().state).not.toBe("off");
    await host.stop();
    expect(host.status().state).toBe("off");
  });
});
