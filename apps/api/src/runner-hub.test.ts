import type { AgentJob, CaseResult } from "@assay/core";
import { describe, expect, it } from "vitest";
import { RunnerHub, type SelfHostedKey } from "./runner-hub.js";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const job = (id: string): AgentJob => ({
  evalCase: { id, env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
});
const keyA: SelfHostedKey = { tenant: "acme", owner: "u-alice", runnerId: "laptop" };
const keyB: SelfHostedKey = { tenant: "acme", owner: "u-bob", runnerId: "laptop" };

describe("RunnerHub", () => {
  it("enqueue 파킹 → lease 가져가기 → complete 가 dispatch promise 를 결과로 resolve", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const dispatched = hub.enqueue(keyA, job("c1")); // 파킹(아직 resolve 안 됨)

    const leased = hub.lease(keyA);
    expect(leased).toEqual({ jobId: "j-0", job: job("c1") });
    expect(hub.lease(keyA)).toBeNull(); // 이미 lease 됨 → 더 없음

    expect(hub.complete(keyA, "j-0", result)).toBe(true);
    await expect(dispatched).resolves.toEqual(result);
  });

  it("lease 는 FIFO; owner(키) 격리 — 다른 owner 의 잡은 안 보인다", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const a1 = hub.enqueue(keyA, job("a1"));
    hub.enqueue(keyA, job("a2"));
    hub.enqueue(keyB, job("b1"));

    // keyB lease 는 keyA 잡을 못 본다(격리).
    expect(hub.lease(keyB)?.job.evalCase.id).toBe("b1");
    // keyA 는 FIFO — a1 먼저.
    expect(hub.lease(keyA)?.job.evalCase.id).toBe("a1");
    expect(hub.lease(keyA)?.job.evalCase.id).toBe("a2");

    hub.complete(keyA, "j-0", result);
    await expect(a1).resolves.toEqual(result);
  });

  it("fail 은 dispatch promise 를 UpstreamError 로 reject", async () => {
    const hub = new RunnerHub({ newJobId: () => "j-x" });
    const d = hub.enqueue(keyA, job("c1"));
    hub.lease(keyA);
    expect(hub.fail(keyA, "j-x", "러너에서 실패")).toBe(true);
    await expect(d).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 502 });
  });

  it("complete/fail 미상 jobId 는 false(이미 완료/만료)", () => {
    const hub = new RunnerHub();
    expect(hub.complete(keyA, "nope", result)).toBe(false);
    expect(hub.fail(keyA, "nope", "x")).toBe(false);
  });

  it("타임아웃: 러너가 안 가져가면 no_runner 로 reject", async () => {
    const hub = new RunnerHub({ queueTimeoutMs: 5 });
    await expect(hub.enqueue(keyA, job("c1"))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      extra: { reason: "no_runner" },
    });
  });
});
