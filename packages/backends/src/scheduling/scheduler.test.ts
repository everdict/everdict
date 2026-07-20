import { type AgentJob, type CaseResult, PaymentRequiredError } from "@everdict/contracts";
import { inMemoryBudget } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { Backend } from "../backend.js";
import { BackendRegistry } from "../placement/registry.js";
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

// A backend that releases dispatch manually so concurrency can be observed.
class ControlledBackend implements Backend {
  inFlight = 0;
  maxSeen = 0;
  handled = 0;
  capacityCalls = 0; // how many times capacity() was probed (asserts the pump probes once per drain, not per placement)
  dispatchedIds: string[] = []; // order of dispatched case ids (for fairness verification)
  memoryBudgetMb: number | undefined;
  cpuBudget: number | undefined;
  private pending: Array<() => void> = [];
  constructor(
    readonly id: string,
    private total: number,
    private readonly used = 0,
  ) {}
  setTotal(total: number): void {
    this.total = total;
  }
  async capacity() {
    this.capacityCalls++;
    return {
      total: this.total,
      used: this.used,
      ...(this.memoryBudgetMb !== undefined ? { memoryBudgetMb: this.memoryBudgetMb } : {}),
      ...(this.cpuBudget !== undefined ? { cpuBudget: this.cpuBudget } : {}),
    };
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

// A job with a tenant + case id (for fairness/quota tests).
function tjob(tenant: string, id: string): AgentJob {
  return {
    harness: { id: "scripted", version: "0" },
    tenant,
    evalCase: { id, env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
  };
}

// Drain micro/macrotasks so the async pump can progress.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("Scheduler", () => {
  it("doesn't dispatch beyond a backend's concurrent slots (total)", async () => {
    const b = new ControlledBackend("a", 2);
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const promises = [job(), job(), job(), job(), job()].map((j) => sched.dispatch(j));
    await flush();

    expect(b.maxSeen).toBe(2); // only 2 slots occupied
    expect(sched.stats().queued).toBe(3); // the rest queued

    b.releaseAll();
    await flush();
    b.releaseAll(); // release the ones newly pumped in
    await flush();
    b.releaseAll();
    await flush();

    await Promise.all(promises);
    expect(b.handled).toBe(5);
    expect(b.maxSeen).toBe(2); // never exceeds 2 throughout
    expect(sched.stats().queued).toBe(0);
  });

  // Lifecycle leak sentinel: the in-flight admission maps are keyed by backend name (rt:tenant:id@ver /
  // self:owner:runnerId). Under runtime/runner churn each distinct name is reserved then released to 0 — pre-fix
  // that 0 lingered forever (one dead entry per backend ever scheduled), an unbounded leak. Now zero deletes the key.
  it("admission maps drop to empty after churning many distinct backends (no per-backend zero-entry leak)", async () => {
    const reg = new BackendRegistry();
    const sched = new Scheduler(reg);
    for (let i = 0; i < 100; i++) {
      const b = new ControlledBackend(`bk-${i}`, 1);
      b.memoryBudgetMb = 1024; // exercise the mem/cpu maps too
      b.cpuBudget = 1000;
      reg.register(`bk-${i}`, b);
      const p = sched.dispatch(job(`bk-${i}`)); // pinned to this churned backend
      await flush();
      b.releaseAll();
      await flush();
      await p;
    }
    const s = sched.stats();
    expect(Object.keys(s.inFlight)).toHaveLength(0); // was 100 (a zero entry per backend)
    expect(Object.keys(s.memInFlightMb)).toHaveLength(0);
    expect(Object.keys(s.cpuInFlight)).toHaveLength(0);
    expect(Object.keys(s.tenantInFlight)).toHaveLength(0);
  });

  it("queues when there's no room, then flushes as slots free", async () => {
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

  it("spreads across multiple backends with leastLoaded", async () => {
    const a = new ControlledBackend("a", 1);
    const b = new ControlledBackend("b", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", a).register("b", b));

    const p = [sched.dispatch(job()), sched.dispatch(job())];
    await flush();

    expect(a.handled).toBe(1);
    expect(b.handled).toBe(1); // one on each backend

    a.releaseAll();
    b.releaseAll();
    await Promise.all(p);
  });

  it("respects the placement.target pin (even when others are free)", async () => {
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

  it("the binPack policy fills the tightest backend first", async () => {
    const a = new ControlledBackend("a", 1);
    const b = new ControlledBackend("b", 3);
    const sched = new Scheduler(new BackendRegistry().register("a", a).register("b", b), { policy: binPackPolicy });

    const p = sched.dispatch(job());
    await flush();
    expect(a.handled).toBe(1); // a, which has the least free, first
    expect(b.handled).toBe(0);

    a.releaseAll();
    await p;
  });

  it("rejects an unregistered pin immediately", async () => {
    const sched = new Scheduler(new BackendRegistry().register("a", new ControlledBackend("a", 1)));
    await expect(sched.dispatch(job("missing"))).rejects.toThrow();
  });

  it("tenant fairness (WFQ): one tenant's bulk submission doesn't starve another", async () => {
    const b = new ControlledBackend("a", 1); // cap=1 → one at a time
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    // A submits 4 first, B submits 1 later — under FIFO, B would be last (5th). Under WFQ, B slips in after one A.
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

    expect(b.dispatchedIds).toEqual(["A0", "B0", "A1", "A2", "A3"]); // B slips in second
  });

  it("tenant quota: doesn't exceed a tenant's concurrent-execution cap even when slots remain", async () => {
    const b = new ControlledBackend("a", 5); // plenty of slots
    const sched = new Scheduler(new BackendRegistry().register("a", b), { tenantQuota: () => 1 });

    const p = [sched.dispatch(tjob("A", "A0")), sched.dispatch(tjob("A", "A1")), sched.dispatch(tjob("B", "B0"))];
    await flush();

    // 5 slots but 1 per tenant → only A0, B0 proceed; A1 waits on quota.
    expect(b.dispatchedIds.sort()).toEqual(["A0", "B0"]);
    expect(sched.stats().queued).toBe(1);
    expect(sched.stats().tenantInFlight).toEqual({ A: 1, B: 1 });

    b.releaseAll(); // A0, B0 complete → A1's quota frees up
    await flush();
    expect(b.dispatchedIds).toContain("A1");

    b.releaseAll();
    await flush();
    await Promise.all(p);
  });

  it("budget: a submission over the runs cap is rejected immediately with 402 (incl. bursts)", async () => {
    const b = new ControlledBackend("a", 5);
    const sched = new Scheduler(new BackendRegistry().register("a", b), {
      budget: inMemoryBudget({ limitFor: () => ({ runs: 2 }) }),
    });
    const p0 = sched.dispatch(tjob("free", "0"));
    const p1 = sched.dispatch(tjob("free", "1"));
    await expect(sched.dispatch(tjob("free", "2"))).rejects.toBeInstanceOf(PaymentRequiredError); // 3rd rejected
    await flush();
    expect(b.dispatchedIds.sort()).toEqual(["0", "1"]); // only 2 run
    b.releaseAll();
    await Promise.all([p0, p1]);
  });

  it("budget: cost is settled on completion, so once past the usd cap the next submission is rejected", async () => {
    // A backend that returns a result with a cost.
    const costly: Backend = {
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

  it("backpressure: RateLimitError once the queue exceeds maxQueueDepth", async () => {
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

  // A job whose harness declares its memory weight (resource-aware admission).
  function heavyJob(id: string, memoryMb: number): AgentJob {
    return {
      ...tjob("acme", id),
      harnessSpec: {
        kind: "command",
        id: "heavy",
        version: "1",
        resources: { memoryMb },
        setup: [],
        command: "run",
        env: {},
        params: {},
        trace: { kind: "none" },
      },
    };
  }

  it("memory budget gates admission even when slots remain", async () => {
    const b = new ControlledBackend("a", 10); // plenty of slots
    b.memoryBudgetMb = 1000;
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const p = [heavyJob("h1", 600), heavyJob("h2", 600)].map((j) => sched.dispatch(j));
    await flush();
    expect(b.handled).toBe(1); // 600 + 600 > 1000 → the second waits despite 9 free slots
    expect(sched.stats().queued).toBe(1);
    expect(sched.stats().memInFlightMb.a).toBe(600);

    b.releaseAll();
    await flush();
    expect(b.handled).toBe(2); // memory freed → the queued heavy job admitted
    b.releaseAll();
    await flush();
    await Promise.all(p);
    expect(sched.stats().memInFlightMb.a ?? 0).toBe(0); // released to 0 → the key is pruned (no per-backend leak), reads as 0
  });

  it("undeclared-memory jobs are admitted outside the memory budget (opt-in gating)", async () => {
    const b = new ControlledBackend("a", 10);
    b.memoryBudgetMb = 500;
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const heavy = sched.dispatch(heavyJob("h1", 500)); // fills the whole envelope
    const light = sched.dispatch(tjob("acme", "l1")); // declares nothing
    await flush();
    expect(b.handled).toBe(2); // the undeclared job is not blocked by the exhausted envelope

    b.releaseAll();
    await flush();
    await Promise.all([heavy, light]);
  });

  // A job whose harness declares its cpu weight (resources.cpu, 1000 = 1 vCPU).
  function cpuJob(id: string, cpu: number): AgentJob {
    return {
      ...tjob("acme", id),
      harnessSpec: {
        kind: "command",
        id: "cruncher",
        version: "1",
        resources: { cpu },
        setup: [],
        command: "run",
        env: {},
        params: {},
        trace: { kind: "none" },
      },
    };
  }

  it("cpu budget gates admission even when slots remain (the memory envelope's twin)", async () => {
    const b = new ControlledBackend("a", 10); // plenty of slots
    b.cpuBudget = 1000;
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const p = [cpuJob("c1", 600), cpuJob("c2", 600)].map((j) => sched.dispatch(j));
    await flush();
    expect(b.handled).toBe(1); // 600 + 600 > 1000 → the second waits despite 9 free slots
    expect(sched.stats().queued).toBe(1);
    expect(sched.stats().cpuInFlight.a).toBe(600);

    b.releaseAll();
    await flush();
    expect(b.handled).toBe(2); // cpu freed → the queued job admitted
    b.releaseAll();
    await flush();
    await Promise.all(p);
    expect(sched.stats().cpuInFlight.a ?? 0).toBe(0); // released to 0 → the key is pruned (no per-backend leak), reads as 0
  });

  it("undeclared-cpu jobs are admitted outside the cpu budget (opt-in gating)", async () => {
    const b = new ControlledBackend("a", 10);
    b.cpuBudget = 500;
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const busy = sched.dispatch(cpuJob("c1", 500)); // fills the whole envelope
    const light = sched.dispatch(tjob("acme", "l1")); // declares nothing
    await flush();
    expect(b.handled).toBe(2); // the undeclared job is not blocked by the exhausted envelope

    b.releaseAll();
    await flush();
    await Promise.all([busy, light]);
  });

  it("a backend without a memory budget keeps slots-only admission", async () => {
    const b = new ControlledBackend("a", 3);
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const p = [heavyJob("h1", 4000), heavyJob("h2", 4000), heavyJob("h3", 4000)].map((j) => sched.dispatch(j));
    await flush();
    expect(b.handled).toBe(3); // no envelope declared → previous behavior

    b.releaseAll();
    await flush();
    await Promise.all(p);
  });

  it("an interactive job jumps ahead of earlier-queued batch jobs when a slot frees", async () => {
    const b = new ControlledBackend("a", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const batchJob = (id: string): AgentJob => ({ ...tjob("acme", id), priority: "batch" });
    const running = sched.dispatch(batchJob("b0")); // occupies the single slot
    await flush();
    const waiting = [batchJob("b1"), batchJob("b2")].map((j) => sched.dispatch(j));
    await flush();
    const interactive = sched.dispatch({ ...tjob("acme", "i1"), priority: "interactive" }); // queued LAST
    await flush();
    expect(sched.stats().queued).toBe(3);

    b.releaseOne(); // slot frees → the interactive job must be picked, not the older batch jobs
    await flush();
    expect(b.dispatchedIds).toEqual(["b0", "i1"]);

    b.releaseAll();
    await flush();
    b.releaseAll();
    await flush();
    b.releaseAll();
    await flush();
    await Promise.all([running, ...waiting, interactive]);
    expect(b.dispatchedIds).toEqual(["b0", "i1", "b1", "b2"]); // batch order itself is preserved (WFQ within class)
  });

  it("cancelQueued drops matching QUEUED entries (rejected CANCELLED, never dispatched) and leaves in-flight ones alone", async () => {
    const b = new ControlledBackend("a", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", b));

    const running = sched.dispatch({ ...tjob("acme", "r1"), batchId: "batch-x" }); // occupies the slot (in flight)
    await flush();
    const queuedX = sched.dispatch({ ...tjob("acme", "q1"), batchId: "batch-x" });
    const queuedY = sched.dispatch({ ...tjob("acme", "q2"), batchId: "batch-y" });
    await flush();
    expect(sched.stats().queued).toBe(2);

    const n = sched.cancelQueued((j) => j.batchId === "batch-x");
    expect(n).toBe(1); // only the queued batch-x entry — the in-flight one is Backend.kill's concern
    await expect(queuedX).rejects.toMatchObject({ code: "CANCELLED" });
    expect(sched.stats().queued).toBe(1);

    b.releaseAll();
    await flush();
    b.releaseAll();
    await flush();
    await Promise.all([running, queuedY]);
    expect(b.dispatchedIds).toEqual(["r1", "q2"]); // q1 never reached the backend
  });

  it("aging promotes a long-waiting batch entry past fresh interactive arrivals (starvation guard)", async () => {
    const b = new ControlledBackend("a", 1);
    let now = 0;
    const sched = new Scheduler(new BackendRegistry().register("a", b), { agingMs: 1000, now: () => now });

    const running = sched.dispatch({ ...tjob("acme", "r0"), priority: "interactive" });
    await flush();
    const oldBatch = sched.dispatch({ ...tjob("acme", "b-old"), priority: "batch" });
    await flush();
    now = 1500; // b-old has now waited past agingMs
    const freshInteractive = sched.dispatch({ ...tjob("acme", "i-fresh"), priority: "interactive" });
    await flush();

    b.releaseOne();
    await flush();
    // Both are urgent now — WFQ order within the urgent class puts the older entry first.
    expect(b.dispatchedIds).toEqual(["r0", "b-old"]);
    b.releaseAll();
    await flush();
    b.releaseAll();
    await flush();
    await Promise.all([running, oldBatch, freshInteractive]);
  });

  it("per-tenant queue depth cap rejects 429 while other tenants keep enqueueing", async () => {
    const b = new ControlledBackend("a", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", b), {
      tenantMaxQueueDepth: (t) => (t === "greedy" ? 2 : 100),
    });

    const running = sched.dispatch(tjob("greedy", "g0")); // in flight (not queued)
    await flush();
    const q1 = sched.dispatch(tjob("greedy", "g1"));
    const q2 = sched.dispatch(tjob("greedy", "g2"));
    await flush();
    await expect(sched.dispatch(tjob("greedy", "g3"))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const other = sched.dispatch(tjob("polite", "p1")); // another workspace is unaffected
    await flush();
    expect(sched.stats().queuedByTenant).toEqual({ greedy: 2, polite: 1 });

    for (let i = 0; i < 5; i++) {
      b.releaseAll();
      await flush();
    }
    await Promise.all([running, q1, q2, other]);
  });

  it("a heavy job routes to the backend whose memory envelope fits it", async () => {
    const small = new ControlledBackend("small", 10);
    small.memoryBudgetMb = 256;
    const big = new ControlledBackend("big", 10);
    big.memoryBudgetMb = 8192;
    const sched = new Scheduler(new BackendRegistry().register("small", small).register("big", big));

    const p = sched.dispatch(heavyJob("h1", 1024));
    await flush();
    expect(big.handled).toBe(1); // small (256Mb) can't hold 1024Mb
    expect(small.handled).toBe(0);

    big.releaseAll();
    await flush();
    await p;
  });
});

describe("Scheduler budget admission", () => {
  it("refunds the admit reservation when a queued job is cancelled (no orphaned run)", async () => {
    const b = new ControlledBackend("a", 1); // one slot
    const budget = inMemoryBudget({ limitFor: () => ({ runs: 5 }) });
    const sched = new Scheduler(new BackendRegistry().register("a", b), { budget });

    const first = sched.dispatch(tjob("t", "j1")); // takes the slot (admitted + dispatched)
    await flush();
    const second = sched.dispatch(tjob("t", "j2")); // no slot → admitted + queued
    await flush();
    expect(budget.usage("t").runs).toBe(2); // both admitted

    const cancelled = sched.cancelQueued((job) => job.evalCase.id === "j2"); // supersede the queued j2
    expect(cancelled).toBe(1);
    await expect(second).rejects.toThrow(/cancelled/i);
    expect(budget.usage("t").runs).toBe(1); // j2's reservation refunded → only the in-flight j1 remains

    b.releaseAll();
    await first;
  });

  it("does NOT reserve a run when the job is rejected for a full queue (no phantom-run leak)", async () => {
    const b = new ControlledBackend("a", 1); // a single slot
    const budget = inMemoryBudget({ limitFor: () => ({ runs: 10 }) });
    const sched = new Scheduler(new BackendRegistry().register("a", b), { maxQueueDepth: 1, budget });

    const first = sched.dispatch(tjob("t", "j1")); // takes the slot (admitted + dispatched)
    await flush();
    const second = sched.dispatch(tjob("t", "j2")); // no slot → admitted + queued (fills the depth-1 queue)
    await flush();

    const runsBefore = budget.usage("t").runs; // 2 admitted so far
    // Third has nowhere to go — the queue is full. It must be rejected BEFORE admit, so no run is reserved.
    await expect(sched.dispatch(tjob("t", "j3"))).rejects.toThrow(/queue is full/i);
    expect(budget.usage("t").runs).toBe(runsBefore); // pre-fix this was runsBefore + 1 (a phantom run)

    b.releaseAll(); // release the in-flight j1 → its settle lets the queued j2 dispatch
    await flush();
    b.releaseAll(); // release j2
    await Promise.all([first, second]);
  });
});

describe("Scheduler capacity probing", () => {
  it("probes each backend's capacity once per drain, not once per placement", async () => {
    const b = new ControlledBackend("a", 0); // start full → jobs queue instead of dispatching
    const sched = new Scheduler(new BackendRegistry().register("a", b));
    const p1 = sched.dispatch(tjob("t", "j1"));
    const p2 = sched.dispatch(tjob("t", "j2"));
    const p3 = sched.dispatch(tjob("t", "j3"));
    await flush();
    expect(sched.stats().queued).toBe(3); // nothing placed yet (no capacity)

    b.setTotal(3); // open enough capacity for all three
    b.capacityCalls = 0; // count only the drain
    sched.poke();
    await flush();

    expect(b.dispatchedIds).toEqual(["j1", "j2", "j3"]); // all three placed in one drain
    expect(b.capacityCalls).toBeLessThanOrEqual(1); // ONE probe for the whole drain, not one per placement
    b.releaseAll();
    await Promise.all([p1, p2, p3]);
  });
});

describe("Scheduler cancellation (AbortSignal)", () => {
  it("dispatch: an already-aborted signal rejects without ever reaching the backend", async () => {
    const b = new ControlledBackend("a", 5);
    const sched = new Scheduler(new BackendRegistry().register("a", b));
    const ac = new AbortController();
    ac.abort();
    await expect(sched.dispatch(job("a"), { signal: ac.signal })).rejects.toThrow(/aborted/i);
    await flush();
    expect(b.handled).toBe(0); // never dispatched
  });

  it("dispatch: aborting a QUEUED job removes it and rejects, and it is never dispatched", async () => {
    const b = new ControlledBackend("a", 1); // a single slot
    const sched = new Scheduler(new BackendRegistry().register("a", b));
    const first = sched.dispatch(tjob("t", "first")); // occupies the slot, stays in flight
    await flush();
    expect(b.handled).toBe(1);

    const ac = new AbortController();
    const second = sched.dispatch(tjob("t", "second"), { signal: ac.signal });
    await flush();
    expect(sched.stats().queued).toBe(1); // no slot → queued

    ac.abort();
    await expect(second).rejects.toThrow(/aborted/i);
    expect(sched.stats().queued).toBe(0); // removed from the queue on abort

    b.releaseAll();
    await first;
    expect(b.dispatchedIds).toEqual(["first"]); // the aborted job never got dispatched
  });
});
