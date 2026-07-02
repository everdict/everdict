import type { AgentJob, CaseResult } from "@assay/core";
import { describe, expect, it, vi } from "vitest";
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
const keyA: SelfHostedKey = { owner: "u-alice", runnerId: "laptop" };
const keyB: SelfHostedKey = { owner: "u-bob", runnerId: "laptop" };

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

  it("타임아웃: reject 가 삼켜져도 원인·대기시간이 console.warn 으로 가시화된다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hub = new RunnerHub({ queueTimeoutMs: 5, newJobId: () => "j-timeout" });
      await hub.enqueue(keyA, job("c1")).catch(() => {}); // reject 를 삼켜도(조용한 실패 재현)
      expect(warn).toHaveBeenCalledOnce();
      const msg = String(warn.mock.calls[0]?.[0]);
      expect(msg).toContain("self:u-alice:laptop"); // 어느 러너인지
      expect(msg).toContain("5ms"); // 얼마나 기다렸는지
      expect(msg).toContain("j-timeout"); // 어느 잡인지
    } finally {
      warn.mockRestore();
    }
  });

  it("유휴 타임아웃은 lease/heartbeat 로 리셋 — 장기 실행 잡(codex 등)이 heartbeat 중이면 거부되지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const hub = new RunnerHub({ queueTimeoutMs: 100, newJobId: () => "j-long" });
      const d = hub.enqueue(keyA, job("c1"));
      let rejected = false;
      d.catch(() => {
        rejected = true; // reject 되면 표시(unhandled 방지 겸)
      });
      expect(hub.lease(keyA)?.jobId).toBe("j-long"); // 러너가 가져감 → 타임아웃 리셋
      // queueTimeoutMs(100)를 훌쩍 넘겨도 30ms 마다 heartbeat 로 리셋 → 거부되지 않는다(총 300ms 경과).
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(30);
        expect(hub.heartbeat(keyA, "j-long")).toBe(true);
      }
      expect(rejected).toBe(false);
      expect(hub.complete(keyA, "j-long", result)).toBe(true);
      await expect(d).resolves.toEqual(result);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leased 후 heartbeat 가 끊기면(러너 사망) 유휴 타임아웃 뒤 no_runner 로 거부", async () => {
    vi.useFakeTimers();
    try {
      const hub = new RunnerHub({ queueTimeoutMs: 50, newJobId: () => "j-dead" });
      const d = hub.enqueue(keyA, job("c1"));
      // 핸들러를 타이머 진행 전에 붙인다(타이머 reject 가 unhandled 로 새지 않게).
      const settled = d.then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      hub.lease(keyA); // 가져갔지만 이후 heartbeat 없음(러너 사망)
      await vi.advanceTimersByTimeAsync(60); // 유휴 50ms 초과
      const r = await settled;
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ e: { code: "UPSTREAM_ERROR", extra: { reason: "no_runner" } } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lease 만료 → 재큐: 러너 사망 시 다음 lease 가 같은 잡을 다시 가져간다", async () => {
    let t = 0;
    const hub = new RunnerHub({ newJobId: () => "j1", now: () => t, leaseTtlMs: 100 });
    hub.enqueue(keyA, job("c1"));
    expect(hub.lease(keyA)?.jobId).toBe("j1"); // 러너 A 가 가져감(t=0)
    expect(hub.lease(keyA)).toBeNull(); // 아직 leased — 더 없음
    t = 50; // TTL 내 — 아직 재큐 안 됨
    expect(hub.lease(keyA)).toBeNull();
    t = 201; // TTL(100) 초과 — 재큐되어 다시 가져갈 수 있다
    expect(hub.lease(keyA)?.jobId).toBe("j1");
  });

  it("leaseWait: 잡 있으면 즉시; 없으면 다음 enqueue 가 깨운다(long-poll)", async () => {
    let m = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${m++}` });
    // 즉시 가용: 파킹 후 leaseWait 는 바로 반환.
    hub.enqueue(keyA, job("a1"));
    expect((await hub.leaseWait(keyA, 1000))?.job.evalCase.id).toBe("a1");
    // 비었을 때: leaseWait 가 대기하다가 enqueue 로 깨어나 그 잡을 가져간다.
    const waiting = hub.leaseWait(keyA, 1000);
    hub.enqueue(keyA, job("a2"));
    expect((await waiting)?.job.evalCase.id).toBe("a2");
  });

  it("leaseWait: 잡이 안 오면 waitMs 후 null", async () => {
    const hub = new RunnerHub();
    expect(await hub.leaseWait(keyA, 5)).toBeNull();
  });

  it("heartbeat 는 lease 를 갱신해 재큐를 막는다", async () => {
    let t = 0;
    const hub = new RunnerHub({ newJobId: () => "j1", now: () => t, leaseTtlMs: 100 });
    hub.enqueue(keyA, job("c1"));
    hub.lease(keyA); // t=0
    t = 80;
    expect(hub.heartbeat(keyA, "j1")).toBe(true); // lease 갱신(leasedAt=80)
    t = 150; // 첫 lease 기준이면 만료지만 heartbeat(80) 기준이면 아직 → 재큐 안 됨
    expect(hub.lease(keyA)).toBeNull();
    expect(hub.heartbeat(keyA, "nope")).toBe(false); // 미상 jobId
  });
});
