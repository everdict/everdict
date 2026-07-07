import type { AgentJob, CaseResult } from "@everdict/core";
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

// 가짜 MCP 표면 — lease_job 는 큐에서 동기 shift(원자적), submit/fail 은 기록. runJob 은 동시 in-flight 를 계측한다.
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
      const next = queue.shift(); // 동기 shift — JS 단일 스레드라 동시 lease 가 같은 잡을 두 번 못 가져간다
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
    return {}; // heartbeat_job 등
  };

  const runJob = async (j: AgentJob): Promise<CaseResult> => {
    runCalls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10)); // 잠깐 잡고 있어야 병렬이 쌓인다
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

describe("runLeaseWorkers — case-level 병렬(maxConcurrent)", () => {
  it("maxConcurrent 워커가 잡을 동시에 집어 병렬 실행한다(잡 3 + 워커 3 → 동시 3)", async () => {
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
    expect(h.peak()).toBe(3); // 셋이 동시에 in-flight
    expect(h.runCalls()).toBe(3);
    expect([...h.submitted].sort()).toEqual(["j0", "j1", "j2"]); // 각 잡 정확히 1회(중복 lease 없음)
    expect(h.failed).toEqual([]);
  });

  it("maxConcurrent=1 → 한 번에 하나씩 직렬 실행(동시도 1)", async () => {
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

  it("워커 수가 잡보다 많아도 각 잡은 정확히 1회만 실행된다(원자적 lease)", async () => {
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

  it("잡 형식 오류 → fail_job 회신(실행 안 함)", async () => {
    const submitted: string[] = [];
    const failed: string[] = [];
    let leased = false;
    let stop = false;
    const callJson = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (name === "lease_job") {
        if (leased) return {};
        leased = true;
        return { jobId: "bad", job: { not: "an AgentJob" } }; // 스키마 위반
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
    expect(ran).toBe(false); // 형식 오류는 실행하지 않는다
  });
});
