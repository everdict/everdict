import type { AgentJob, CaseResult } from "@assay/core";
import { describe, expect, it } from "vitest";
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

// 호출 스크립트형 가짜 세션 — 첫 lease 에 잡 1개, 이후 빈 응답.
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
  it("start→잡 실행(running)→회신→idle→stop(off) 의 상태 전이를 이벤트로 낸다", async () => {
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
    // 잡 결과가 회신됐다 — submit_job_result(j1, RESULT).
    const submit = calls.find((c) => c.name === "submit_job_result");
    expect(submit?.args).toMatchObject({ jobId: "j1", result: RESULT });
    // 종료 통지(성공)가 났다 — OS 알림의 근거.
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ result: RESULT });
    expect(done[0]?.error).toBeUndefined();
  });

  it("start 는 멱등(중복 루프 없음), capabilities 는 상태에 실린다", async () => {
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
    await host.start(); // 멱등
    expect(host.status().capabilities).toEqual(["repo", "docker"]);
    await host.stop();
    expect(host.status().state).toBe("off");
  });
});
