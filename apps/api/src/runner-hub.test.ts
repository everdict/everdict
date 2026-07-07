import type { AgentJob, CaseResult } from "@everdict/core";
import { describe, expect, it, vi } from "vitest";
import { RunnerHub, type SelfHostedKey, poolKeyFor } from "./runner-hub.js";

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
// case.image 를 요구하는 잡 — 컨테이너 실행이라 러너에 docker capability 가 필요.
const imageJob = (id: string): AgentJob => ({
  ...job(id),
  evalCase: { ...job(id).evalCase, image: "spreadsheetbench:v1" },
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
    await expect(dispatched).resolves.toMatchObject({ result });
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
    await expect(a1).resolves.toMatchObject({ result });
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

  // placement 게이트: case.image(컨테이너) 잡을 docker 없는 러너에 leasing 하면 잘못된 환경(호스트 폴백)에서 돈다 → 거부.
  it("게이트: image 잡 + docker 없는 러너 → lease 안 하고 그 잡을 capability_mismatch 로 거부", async () => {
    const hub = new RunnerHub({ newJobId: () => "j-img" });
    const d = hub.enqueue(keyA, imageJob("c-img"));
    const settled = d.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    // 러너가 repo 만 광고(docker 없음) → 이 잡은 못 돌린다 → null(가져갈 것 없음) + 잡은 거부됨.
    expect(hub.lease(keyA, ["repo"])).toBeNull();
    const r = await settled;
    expect(r).toMatchObject({
      ok: false,
      e: { code: "UPSTREAM_ERROR", extra: { reason: "capability_mismatch", missing: ["docker"] } },
    });
  });

  it("게이트: image 잡 + docker 러너 → 정상 lease", () => {
    const hub = new RunnerHub({ newJobId: () => "j-img" });
    hub.enqueue(keyA, imageJob("c-img"));
    expect(hub.lease(keyA, ["repo", "docker"])?.job.evalCase.id).toBe("c-img");
  });

  it("게이트: capabilities 미전달이면 게이트 없음(하위호환) — image 잡도 lease", () => {
    const hub = new RunnerHub({ newJobId: () => "j-img" });
    hub.enqueue(keyA, imageJob("c-img"));
    expect(hub.lease(keyA)?.job.evalCase.id).toBe("c-img"); // capabilities undefined → 게이트 스킵
  });

  it("게이트: image 잡은 거부하되 뒤따르는 비-image 잡은 같은 러너가 정상 lease", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const dImg = hub.enqueue(keyA, imageJob("c-img")); // j-0 (docker 필요)
    dImg.catch(() => {}); // 거부될 것 — unhandled 방지
    hub.enqueue(keyA, job("c-plain")); // j-1 (image 없음)
    // docker 없는 러너: image 잡은 건너뛰며 거부, 그 다음 비-image 잡을 가져간다.
    expect(hub.lease(keyA, ["repo"])?.job.evalCase.id).toBe("c-plain");
    await expect(dImg).rejects.toMatchObject({ extra: { reason: "capability_mismatch" } });
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
      await expect(d).resolves.toMatchObject({ result });
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

// 워크스페이스 풀(self:ws) — 같은 owner 의 여러 러너가 한 풀 큐를 드레인. runnerId=POOL_RUNNER("*").
describe("RunnerHub — 워크스페이스 풀(N 러너 드레인)", () => {
  const OWNER = "ws:acme";
  const r1: SelfHostedKey = { owner: OWNER, runnerId: "r1" };
  const r2: SelfHostedKey = { owner: OWNER, runnerId: "r2" };

  it("풀에 넣은 잡을 그 owner 의 여러 러너가 나눠 가져가고, 자기 키로 complete 한다", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    const d1 = hub.enqueue(poolKeyFor(OWNER), job("p1")); // j-0
    const d2 = hub.enqueue(poolKeyFor(OWNER), job("p2")); // j-1
    expect(hub.lease(r1)?.job.evalCase.id).toBe("p1"); // r1 풀에서 하나
    expect(hub.lease(r2)?.job.evalCase.id).toBe("p2"); // r2 풀에서 다음
    expect(hub.lease(r1)).toBeNull(); // 풀 소진
    // 풀 잡은 풀 큐에 남아있지만 러너는 자기 키로 complete → locate 가 풀 큐에서 찾는다.
    // ranBy = 실제 완료 러너(풀 키 "*" 가 아니라 진짜 r1/r2) → provenance.runner 가 올바르게 남는다.
    expect(hub.complete(r1, "j-0", result)).toBe(true);
    await expect(d1).resolves.toEqual({ result, ranBy: "r1" });
    expect(hub.complete(r2, "j-1", result)).toBe(true);
    await expect(d2).resolves.toEqual({ result, ranBy: "r2" });
  });

  it("풀: capability 불일치는 거부가 아니라 건너뛴다 — docker 없는 러너는 지나치고 docker 러너가 가져간다", async () => {
    const hub = new RunnerHub({ newJobId: () => "j-img" });
    const d = hub.enqueue(poolKeyFor(OWNER), imageJob("needs-docker")); // docker 요구
    expect(hub.lease({ owner: OWNER, runnerId: "no-docker" }, ["git"])).toBeNull(); // 건너뜀(거부 아님)
    // 잡이 아직 살아있음 → docker 러너가 가져간다.
    expect(hub.lease({ owner: OWNER, runnerId: "has-docker" }, ["git", "docker"])?.job.evalCase.id).toBe(
      "needs-docker",
    );
    expect(hub.complete({ owner: OWNER, runnerId: "has-docker" }, "j-img", result)).toBe(true);
    await expect(d).resolves.toMatchObject({ result });
  });

  it("풀: 자기 큐 잡을 풀 잡보다 먼저 가져간다", () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `j-${n++}` });
    hub.enqueue(poolKeyFor(OWNER), job("pool-job")); // j-0
    hub.enqueue(r1, job("mine")); // j-1
    expect(hub.lease(r1)?.job.evalCase.id).toBe("mine"); // 자기 큐 먼저
    expect(hub.lease(r1)?.job.evalCase.id).toBe("pool-job"); // 그다음 풀
  });

  it("풀: 다른 owner 의 풀 잡은 안 보인다(격리)", () => {
    const hub = new RunnerHub({ newJobId: () => "j-x" });
    hub.enqueue(poolKeyFor("ws:beta"), job("beta-pool"));
    expect(hub.lease(r1)).toBeNull(); // acme 러너는 beta 풀 못 봄
  });

  it("풀: enqueue 가 long-poll 중인 그 owner 의 러너를 깨운다", async () => {
    const hub = new RunnerHub({ newJobId: () => "j-w" });
    const waiting = hub.leaseWait(r1, 1000); // r1 이 자기 키로 대기
    hub.enqueue(poolKeyFor(OWNER), job("pooled")); // 풀 enqueue → wakeOwner 가 r1 깨움
    expect((await waiting)?.job.evalCase.id).toBe("pooled");
    hub.complete(r1, "j-w", result);
  });

  it("풀 wake 공정성(라운드-로빈): 두 러너가 대기 중 두 잡 → 서로 다른 러너가 하나씩(한 러너 독식 방지)", async () => {
    let n = 0;
    const hub = new RunnerHub({ newJobId: () => `w-${n++}` });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const seen: string[] = [];
    // 미니 워커 루프 — 대기하다 잡 받으면 처리(complete) 후 재대기, null 이면 재폴링(실 워커와 동일). 최대 6회.
    const worker = (runnerId: string) => async () => {
      for (let i = 0; i < 6 && seen.length < 2; i++) {
        const l = await hub.leaseWait({ owner: OWNER, runnerId }, 200);
        if (l) {
          seen.push(runnerId);
          hub.complete({ owner: OWNER, runnerId }, l.jobId, result);
        }
      }
    };
    const workers = Promise.all([worker("r1")(), worker("r2")()]);
    await sleep(15); // 둘 다 park
    hub.enqueue(poolKeyFor(OWNER), job("p1")); // wake cursor=0 → r1 먼저 → r1 처리 후 재park
    await sleep(15);
    hub.enqueue(poolKeyFor(OWNER), job("p2")); // wake cursor=1 → r2 먼저 → r2 처리(회전)
    await workers;
    expect([...seen].sort()).toEqual(["r1", "r2"]); // 두 러너가 하나씩(독식 아님)
  });
});
