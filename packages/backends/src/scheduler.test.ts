import { type AgentJob, type CaseResult, PaymentRequiredError } from "@everdict/core";
import { describe, expect, it } from "vitest";
import type { Backend } from "./backend.js";
import { inMemoryBudget } from "./budget.js";
import { BackendRegistry } from "./registry.js";
import { Scheduler, binPackPolicy } from "./scheduler.js";

function result(id: string): CaseResult {
  return {
    caseId: "c",
    harness: id,
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
  };
}

// dispatch 를 수동으로 풀어 동시성을 관찰할 수 있는 백엔드.
class ControlledBackend implements Backend {
  inFlight = 0;
  maxSeen = 0;
  handled = 0;
  dispatchedIds: string[] = []; // 디스패치된 케이스 id 순서(공정성 검증용)
  private pending: Array<() => void> = [];
  constructor(
    readonly id: string,
    private readonly total: number,
    private readonly used = 0,
  ) {}
  async capacity() {
    return { total: this.total, used: this.used };
  }
  dispatch(job: AgentJob): Promise<CaseResult> {
    this.inFlight++;
    this.handled++;
    this.dispatchedIds.push(job.evalCase.id);
    this.maxSeen = Math.max(this.maxSeen, this.inFlight);
    return new Promise<CaseResult>((resolve) => {
      this.pending.push(() => {
        this.inFlight--;
        resolve(result(this.id));
      });
    });
  }
  releaseOne(): void {
    this.pending.shift()?.();
  }
  releaseAll(): void {
    while (this.pending.length > 0) this.releaseOne();
  }
}

function job(target?: string): AgentJob {
  return {
    harness: { id: "scripted", version: "0" },
    evalCase: {
      id: "c",
      env: { kind: "repo", source: { files: {} } },
      task: "t",
      graders: [],
      timeoutSec: 1,
      tags: [],
      ...(target ? { placement: { target } } : {}),
    },
  };
}

// 테넌트 + 케이스 id 를 가진 잡(공정성/쿼터 테스트용).
function tjob(tenant: string, id: string): AgentJob {
  return {
    harness: { id: "scripted", version: "0" },
    tenant,
    evalCase: { id, env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
  };
}

// 마이크로/매크로태스크를 비워 비동기 pump 가 진행되게 한다.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("Scheduler", () => {
  it("백엔드 동시 슬롯(total)을 넘겨 디스패치하지 않는다", async () => {
    const b = new ControlledBackend("a", 2);
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const promises = [job(), job(), job(), job(), job()].map((j) => sched.dispatch(j));
    await flush();

    expect(b.maxSeen).toBe(2); // 슬롯 2개만 점유
    expect(sched.stats().queued).toBe(3); // 나머지는 큐

    b.releaseAll();
    await flush();
    b.releaseAll(); // 펌프로 새로 들어온 것들 해제
    await flush();
    b.releaseAll();
    await flush();

    await Promise.all(promises);
    expect(b.handled).toBe(5);
    expect(b.maxSeen).toBe(2); // 끝까지 2를 넘지 않음
    expect(sched.stats().queued).toBe(0);
  });

  it("자리가 없으면 큐잉했다가 슬롯이 비면 흘려보낸다", async () => {
    const b = new ControlledBackend("a", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const p = [job(), job(), job()].map((j) => sched.dispatch(j));
    await flush();
    expect(b.handled).toBe(1);
    expect(sched.stats().queued).toBe(2);

    b.releaseOne();
    await flush();
    expect(b.handled).toBe(2);
    expect(sched.stats().queued).toBe(1);

    b.releaseAll();
    await flush();
    b.releaseAll();
    await flush();
    await Promise.all(p);
    expect(b.handled).toBe(3);
  });

  it("leastLoaded 로 여러 백엔드에 분산한다", async () => {
    const a = new ControlledBackend("a", 1);
    const b = new ControlledBackend("b", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", a).register("b", b));

    const p = [sched.dispatch(job()), sched.dispatch(job())];
    await flush();

    expect(a.handled).toBe(1);
    expect(b.handled).toBe(1); // 각 백엔드에 하나씩

    a.releaseAll();
    b.releaseAll();
    await Promise.all(p);
  });

  it("placement.target pin 을 존중한다 (다른 곳이 비어도)", async () => {
    const a = new ControlledBackend("a", 5);
    const b = new ControlledBackend("b", 5);
    const sched = new Scheduler(new BackendRegistry().register("a", a).register("b", b));

    const p = sched.dispatch(job("b"));
    await flush();
    expect(a.handled).toBe(0);
    expect(b.handled).toBe(1);

    b.releaseAll();
    await p;
  });

  it("binPack 정책은 여유가 적은 곳부터 채운다", async () => {
    const a = new ControlledBackend("a", 1);
    const b = new ControlledBackend("b", 3);
    const sched = new Scheduler(new BackendRegistry().register("a", a).register("b", b), { policy: binPackPolicy });

    const p = sched.dispatch(job());
    await flush();
    expect(a.handled).toBe(1); // free 가 가장 적은 a 먼저
    expect(b.handled).toBe(0);

    a.releaseAll();
    await p;
  });

  it("미등록 pin 은 즉시 거절한다", async () => {
    const sched = new Scheduler(new BackendRegistry().register("a", new ControlledBackend("a", 1)));
    await expect(sched.dispatch(job("missing"))).rejects.toThrow();
  });

  it("테넌트 공정성(WFQ): 한 테넌트의 대량 제출이 다른 테넌트를 굶기지 않는다", async () => {
    const b = new ControlledBackend("a", 1); // cap=1 → 한 번에 하나씩
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    // A 가 4건 먼저, B 가 1건 나중에 — FIFO 라면 B 는 마지막(5번째). WFQ 라면 A 한 건 뒤에 끼어든다.
    const p = [
      sched.dispatch(tjob("A", "A0")),
      sched.dispatch(tjob("A", "A1")),
      sched.dispatch(tjob("A", "A2")),
      sched.dispatch(tjob("A", "A3")),
      sched.dispatch(tjob("B", "B0")),
    ];
    await flush();
    for (let i = 0; i < 5; i++) {
      b.releaseAll();
      await flush();
    }
    await Promise.all(p);

    expect(b.dispatchedIds).toEqual(["A0", "B0", "A1", "A2", "A3"]); // B 가 2번째로 끼어듦
  });

  it("테넌트 쿼터: 자리가 남아도 테넌트별 동시 실행 상한을 넘지 않는다", async () => {
    const b = new ControlledBackend("a", 5); // 슬롯은 넉넉
    const sched = new Scheduler(new BackendRegistry().register("a", b), { tenantQuota: () => 1 });

    const p = [sched.dispatch(tjob("A", "A0")), sched.dispatch(tjob("A", "A1")), sched.dispatch(tjob("B", "B0"))];
    await flush();

    // 슬롯 5개지만 테넌트당 1 → A0, B0 만 진행, A1 은 쿼터로 대기.
    expect(b.dispatchedIds.sort()).toEqual(["A0", "B0"]);
    expect(sched.stats().queued).toBe(1);
    expect(sched.stats().tenantInFlight).toEqual({ A: 1, B: 1 });

    b.releaseAll(); // A0, B0 완료 → A1 의 쿼터가 풀림
    await flush();
    expect(b.dispatchedIds).toContain("A1");

    b.releaseAll();
    await flush();
    await Promise.all(p);
  });

  it("예산: runs 상한을 넘는 제출은 402 로 즉시 거절(버스트 포함)", async () => {
    const b = new ControlledBackend("a", 5);
    const sched = new Scheduler(new BackendRegistry().register("a", b), {
      budget: inMemoryBudget({ limitFor: () => ({ runs: 2 }) }),
    });
    const p0 = sched.dispatch(tjob("free", "0"));
    const p1 = sched.dispatch(tjob("free", "1"));
    await expect(sched.dispatch(tjob("free", "2"))).rejects.toBeInstanceOf(PaymentRequiredError); // 3번째 거절
    await flush();
    expect(b.dispatchedIds.sort()).toEqual(["0", "1"]); // 2건만 실행
    b.releaseAll();
    await Promise.all([p0, p1]);
  });

  it("예산: 완료 시 cost 가 settle 되어 usd 상한을 넘기면 다음 제출 거절", async () => {
    // cost 가 있는 결과를 주는 백엔드.
    const costly: Backend = {
      id: "c",
      async capacity() {
        return { total: 5, used: 0 };
      },
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: "h",
          trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.06 } }],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [],
        };
      },
    };
    const budget = inMemoryBudget({ limitFor: () => ({ usd: 0.1 }) });
    const sched = new Scheduler(new BackendRegistry().register("c", costly), { budget });

    await sched.dispatch(tjob("free", "0")); // +0.06
    await flush();
    await sched.dispatch(tjob("free", "1")); // +0.06 → 0.12
    await flush();
    expect(budget.usage("free").usd).toBeCloseTo(0.12);
    await expect(sched.dispatch(tjob("free", "2"))).rejects.toBeInstanceOf(PaymentRequiredError); // 0.12 >= 0.1
  });

  it("백프레셔: 큐가 maxQueueDepth 를 넘으면 RateLimitError", async () => {
    const b = new ControlledBackend("a", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", b), { maxQueueDepth: 2 });

    const p1 = sched.dispatch(job());
    await flush(); // placed → queue 0
    const p2 = sched.dispatch(job());
    await flush(); // full → queue 1
    const p3 = sched.dispatch(job());
    await flush(); // queue 2
    expect(sched.stats().queued).toBe(2);

    await expect(sched.dispatch(job())).rejects.toMatchObject({ code: "RATE_LIMITED" });

    b.releaseAll();
    await flush();
    b.releaseAll();
    await flush();
    b.releaseAll();
    await flush();
    await Promise.all([p1, p2, p3]);
  });
});
