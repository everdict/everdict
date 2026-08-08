import type { AdmissionLedger } from "@everdict/application-control";
import { type CaseJob, type CaseResult, PaymentRequiredError } from "@everdict/contracts";
import { inMemoryBudget } from "@everdict/domain";
import { describe, expect, it, vi } from "vitest";
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
  dispatch(job: CaseJob): Promise<CaseResult> {
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

// The durable run ledger as two replicas share it: a row appears when compute starts (the onStarted
// queued→running flip) and disappears when the run goes terminal. Stands in for `RunStore.inFlightByTenant`.
class FleetLedger implements AdmissionLedger {
  private readonly counts = new Map<string, number>();
  start(tenant: string): void {
    this.counts.set(tenant, (this.counts.get(tenant) ?? 0) + 1);
  }
  settle(tenant: string): void {
    this.counts.set(tenant, Math.max(0, (this.counts.get(tenant) ?? 0) - 1));
  }
  total(): number {
    return [...this.counts.values()].reduce((a, b) => a + b, 0);
  }
  async inFlightByTenant(): Promise<Record<string, number>> {
    return Object.fromEntries(this.counts);
  }
}

// A ControlledBackend that also writes to the shared ledger, the way a dispatched case's run row does.
class LedgerBackend extends ControlledBackend {
  constructor(
    id: string,
    total: number,
    private readonly ledger: FleetLedger,
  ) {
    super(id, total);
  }
  override dispatch(job: CaseJob): Promise<CaseResult> {
    const tenant = job.tenant ?? "default";
    this.ledger.start(tenant);
    return super.dispatch(job).finally(() => this.ledger.settle(tenant));
  }
}

function job(target?: string): CaseJob {
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
function tjob(tenant: string, id: string): CaseJob {
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

  it("tenant quota: two control-plane replicas sharing one run ledger admit the cap ONCE, not once each", async () => {
    // Given: one shared ledger (the durable run rows) and two schedulers — the multi-replica deployment.
    const ledger = new FleetLedger();
    const backendA = new LedgerBackend("a", 10, ledger);
    const backendB = new LedgerBackend("b", 10, ledger);
    const opts = { tenantQuota: () => 5, ledger };
    const replicaA = new Scheduler(new BackendRegistry().register("a", backendA), opts);
    const replicaB = new Scheduler(new BackendRegistry().register("b", backendB), opts);

    // When: replica A takes 3 of the workspace's 5 slots …
    const pa = [0, 1, 2].map((i) => replicaA.dispatch(tjob("acme", `A${i}`)));
    await flush();
    expect(backendA.dispatchedIds).toEqual(["A0", "A1", "A2"]);

    // … and replica B is then handed 5 more jobs of the same workspace.
    const pb = [0, 1, 2, 3, 4].map((i) => replicaB.dispatch(tjob("acme", `B${i}`)));
    await flush();

    // Then: B sees A's 3 in the ledger and admits only the remaining 2 — 5 in flight fleet-wide, not 8.
    // (Pre-fix, B's own empty map said 0 in flight and it admitted all 5.)
    expect(backendB.dispatchedIds).toEqual(["B0", "B1"]);
    expect(ledger.total()).toBe(5);
    expect(replicaB.stats().queued).toBe(3);

    // And: a terminal run frees its slot by leaving the ledger — no counter to reconcile.
    backendA.releaseAll();
    await flush();
    replicaB.poke(); // the other replica settles out-of-band; a poke is what tells this one to look again
    await flush();
    expect(backendB.dispatchedIds).toEqual(["B0", "B1", "B2", "B3", "B4"]);

    backendB.releaseAll();
    await flush();
    await Promise.all([...pa, ...pb]);
  });

  it("tenant quota: a ledger that cannot answer falls back to this replica's own count (never a stall)", async () => {
    const b = new ControlledBackend("a", 5);
    const failing = {
      inFlightByTenant: () => Promise.reject(new Error("database unreachable")),
    };
    const sched = new Scheduler(new BackendRegistry().register("a", b), { tenantQuota: () => 1, ledger: failing });

    const p = [sched.dispatch(tjob("A", "A0")), sched.dispatch(tjob("A", "A1"))];
    await flush();

    expect(b.dispatchedIds).toEqual(["A0"]); // the local quota still holds — placement is not blocked by the read
    b.releaseAll();
    await flush();
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
  function heavyJob(id: string, memoryMb: number): CaseJob {
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
  function cpuJob(id: string, cpu: number): CaseJob {
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

    const batchJob = (id: string): CaseJob => ({ ...tjob("acme", id), priority: "batch" });
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

  it("queueEntries reports the wait queue in the effective scan order with identity fields", async () => {
    const b = new ControlledBackend("a", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", b));
    const inflight = sched.dispatch(tjob("t1", "c1")); // occupies the slot
    void sched.dispatch(tjob("t1", "c2")).catch(() => {});
    void sched.dispatch(tjob("t2", "c3")).catch(() => {});
    await flush();

    // WFQ fairness: t2's first entry (lower virtual-finish time) is scanned before t1's second one, even
    // though it arrived later — the entries report the REAL scan order, not FIFO.
    const entries = sched.queueEntries();
    expect(entries.map((e) => e.caseId)).toEqual(["c3", "c2"]);
    const first = entries[0];
    expect(first).toMatchObject({ tenant: "t2", urgent: false, promoted: false });
    expect(first?.id).toMatch(/^q\d+$/);
    expect(typeof first?.enqueuedAt).toBe("number");

    // An interactive job joins the urgent class → scanned (and reported) ahead of the waiting batch entries.
    void sched.dispatch({ ...tjob("t1", "c4"), priority: "interactive" }).catch(() => {});
    await flush();
    expect(sched.queueEntries().map((e) => e.caseId)).toEqual(["c4", "c3", "c2"]);
    expect(sched.queueEntries()[0]).toMatchObject({ urgent: true });

    b.releaseAll();
    await inflight;
  });

  it("cancelEntry removes ONE waiting entry, rejects its dispatch as CANCELLED, and never dispatches it", async () => {
    const b = new ControlledBackend("a", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", b));
    const first = sched.dispatch(tjob("t", "c1"));
    const second = sched.dispatch(tjob("t", "c2"));
    await flush();
    const entry = sched.queueEntries().find((e) => e.caseId === "c2");
    expect(entry).toBeDefined();

    expect(sched.cancelEntry(entry?.id ?? "")).toBe(true);
    await expect(second).rejects.toThrow(/cancelled/i);
    expect(sched.stats().queued).toBe(0);
    expect(sched.cancelEntry("q999")).toBe(false); // unknown / already settled

    b.releaseAll();
    await first;
    expect(b.dispatchedIds).toEqual(["c1"]); // the cancelled entry never reached the backend
  });

  it("promoteEntry moves a waiting entry to the front of the effective order so it places next", async () => {
    const b = new ControlledBackend("a", 1);
    const sched = new Scheduler(new BackendRegistry().register("a", b));
    const all = [sched.dispatch(tjob("t", "c1")), sched.dispatch(tjob("t", "c2")), sched.dispatch(tjob("t", "c3"))];
    await flush();
    expect(sched.queueEntries().map((e) => e.caseId)).toEqual(["c2", "c3"]);

    const entry = sched.queueEntries().find((e) => e.caseId === "c3");
    expect(sched.promoteEntry(entry?.id ?? "")).toBe(true);
    expect(sched.queueEntries().map((e) => e.caseId)).toEqual(["c3", "c2"]);
    expect(sched.queueEntries()[0]).toMatchObject({ urgent: true, promoted: true });
    expect(sched.promoteEntry("q999")).toBe(false);

    b.releaseOne();
    await flush();
    b.releaseOne();
    await flush();
    b.releaseOne();
    await flush();
    await Promise.all(all);
    expect(b.dispatchedIds).toEqual(["c1", "c3", "c2"]); // the promoted entry ran before the earlier-queued one
  });
});

// Harness-keyed capacity (CaseCapacityAware) — one backend, several harnesses, each admitted by its OWN pool.
// Pre-fix the Scheduler admitted against the backend-wide aggregate only, so a job whose harness pool was full
// was dispatched into a case-by-case refusal while a sibling harness's room said "free".
describe("Scheduler — harness-keyed capacity (CaseCapacityAware)", () => {
  class PooledBackend extends ControlledBackend {
    pools = new Map<string, { total: number; used: number }>();
    async capacityFor(j: CaseJob): Promise<{ total: number; used: number } | undefined> {
      return this.pools.get(`${j.harness.id}@${j.harness.version}`);
    }
  }
  const jobFor = (harness: string, caseId: string): CaseJob => ({
    harness: { id: harness, version: "1" },
    evalCase: {
      id: caseId,
      env: { kind: "repo", source: { files: {} } },
      task: "t",
      graders: [],
      timeoutSec: 1,
      tags: [],
    },
  });

  it("admits each harness by its own pool — a full pool queues its jobs while a sibling harness keeps flowing", async () => {
    const b = new PooledBackend("topo", 8);
    b.pools.set("a@1", { total: 1, used: 0 });
    b.pools.set("b@1", { total: 2, used: 0 });
    const sched = new Scheduler(new BackendRegistry().register("topo", b));

    const all = [
      sched.dispatch(jobFor("a", "a1")),
      sched.dispatch(jobFor("a", "a2")),
      sched.dispatch(jobFor("b", "b1")),
    ];
    await flush();

    // a's pool holds ONE session: a1 in flight, a2 queued; b1 flowed past it (HOL avoidance), well under the
    // backend-wide 8 slots that pre-fix would have admitted all three into.
    expect(b.dispatchedIds).toEqual(["a1", "b1"]);
    expect(sched.stats().queued).toBe(1);

    b.releaseOne(); // a1 settles → the per-harness in-flight count frees a's slot
    await flush();
    expect(b.dispatchedIds).toEqual(["a1", "b1", "a2"]);
    b.releaseAll();
    await flush();
    b.releaseAll();
    await Promise.all(all);
  });

  it("counts the pool's externally-held sessions (another lane) against admission, and flows once they free", async () => {
    const b = new PooledBackend("topo", 8);
    b.pools.set("a@1", { total: 2, used: 2 }); // the conversation lane holds both sessions
    const sched = new Scheduler(new BackendRegistry().register("topo", b));

    const p = sched.dispatch(jobFor("a", "a1"));
    await flush();
    expect(b.dispatchedIds).toEqual([]); // no pool room anywhere → queued, not dispatched into a refusal
    expect(sched.stats().queued).toBe(1);

    b.pools.set("a@1", { total: 2, used: 1 }); // a session closed
    sched.poke();
    await flush();
    expect(b.dispatchedIds).toEqual(["a1"]);
    b.releaseAll();
    await p;
  });

  it("a harness with no pool signal falls back to the backend-wide slots (cold start / no declaration)", async () => {
    const b = new PooledBackend("topo", 2);
    const sched = new Scheduler(new BackendRegistry().register("topo", b));

    const all = [
      sched.dispatch(jobFor("c", "c1")),
      sched.dispatch(jobFor("c", "c2")),
      sched.dispatch(jobFor("c", "c3")),
    ];
    await flush();
    expect(b.dispatchedIds).toEqual(["c1", "c2"]); // the aggregate (total 2) still gates
    expect(sched.stats().queued).toBe(1);

    b.releaseAll();
    await flush();
    b.releaseAll();
    await Promise.all(all);
  });
});

// C12 (TRUST-07 hardening): the ledger SNAPSHOT is a stale read by construction — two schedulers reading the
// same headroom in the same instant both pass the pre-filter. The atomic permit (AdmissionLedger.tryAdmit)
// is the actual limit; these tests drive two Scheduler instances over ONE shared permit ledger.
describe("Scheduler — hard tenant quota via the atomic admission permit", () => {
  class PermitLedger implements AdmissionLedger {
    readonly permits = new Map<string, string>(); // permitId → tenant
    // A deliberately STALE snapshot: always empty, so the pre-filter never trips and the permit alone gates —
    // the same worst case as two replicas probing before either has dispatched.
    async inFlightByTenant(): Promise<Record<string, number>> {
      return {};
    }
    async tryAdmit(tenant: string, permitId: string, quota: number): Promise<boolean> {
      let held = 0;
      for (const t of this.permits.values()) if (t === tenant) held++;
      if (held >= quota) return false;
      this.permits.set(permitId, tenant);
      return true;
    }
    async releaseAdmission(permitId: string): Promise<void> {
      this.permits.delete(permitId);
    }
  }

  it("two schedulers over one permit ledger admit the quota ONCE — even against a stale snapshot", async () => {
    const ledger = new PermitLedger();
    const a = new ControlledBackend("a", 100);
    const b = new ControlledBackend("b", 100);
    const schedA = new Scheduler(new BackendRegistry().register("a", a), { tenantQuota: () => 3, ledger });
    const schedB = new Scheduler(new BackendRegistry().register("b", b), { tenantQuota: () => 3, ledger });

    // Both replicas dispatch a burst CONCURRENTLY — no ledger settling between them, the exact race the
    // snapshot check cannot see.
    const pa = [0, 1, 2, 3].map((i) => schedA.dispatch(tjob("acme", `A${i}`)));
    const pb = [0, 1, 2, 3].map((i) => schedB.dispatch(tjob("acme", `B${i}`)));
    await flush();
    await flush();

    expect(a.dispatchedIds.length + b.dispatchedIds.length).toBe(3); // the quota, fleet-wide, exactly once
    expect(ledger.permits.size).toBe(3);

    // Settling frees permits and the rest are admitted — the limit throttles, it never strands work.
    a.releaseAll();
    b.releaseAll();
    await flush();
    await flush();
    a.releaseAll();
    b.releaseAll();
    await flush();
    await flush();
    a.releaseAll();
    b.releaseAll();
    await flush();
    await Promise.all([...pa, ...pb]);
    expect(a.dispatchedIds.length + b.dispatchedIds.length).toBe(8);
    expect(ledger.permits.size).toBe(0); // every permit returned at settle
  });

  it("in-flight permits are renewed on the heartbeat and the heartbeat dies with the last permit", async () => {
    // The lease contract: the ledger's reap frees only permits whose holder stopped renewing, so the scheduler
    // must renew everything its running work holds — and stop once nothing does (no timer pinning idle replicas).
    class RenewRecordingLedger extends PermitLedger {
      readonly renewed: string[][] = [];
      async renewAdmissions(permitIds: string[]): Promise<void> {
        this.renewed.push([...permitIds]);
      }
    }
    const ledger = new RenewRecordingLedger();
    const b = new ControlledBackend("a", 100);
    const sched = new Scheduler(new BackendRegistry().register("a", b), {
      tenantQuota: () => 3,
      ledger,
      permitRenewMs: 5,
    });
    const p = sched.dispatch(tjob("acme", "x"));
    await flush();
    expect(b.dispatchedIds).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(ledger.renewed.length).toBeGreaterThan(0); // the lease was renewed while the work ran
    expect(ledger.renewed[0]).toHaveLength(1);

    b.releaseAll();
    await p;
    await flush();
    const renewsAtSettle = ledger.renewed.length;
    await new Promise((r) => setTimeout(r, 25));
    expect(ledger.renewed.length).toBe(renewsAtSettle); // heartbeat stopped with the last permit
    expect(ledger.permits.size).toBe(0);
  });

  it("an abort racing tryAdmit never dispatches — queue removal is the commit point and the permit comes back", async () => {
    // The window: permitId is assigned, tryAdmit is awaiting, the abort fires → onAbort removes the entry,
    // rejects it, and releases (a claim that committed behind the abort may land only later). Pre-fix, pump
    // ignored the second remove()'s false and dispatched the rejected entry anyway — saved only by backends
    // refusing pre-aborted signals, a convention carrying an invariant — while re-holding a released permit.
    class GatedLedger extends PermitLedger {
      releaseGate?: () => void;
      override async tryAdmit(tenant: string, permitId: string, quota: number): Promise<boolean> {
        await new Promise<void>((r) => {
          this.releaseGate = r;
        });
        return super.tryAdmit(tenant, permitId, quota);
      }
    }
    const ledger = new GatedLedger();
    const b = new ControlledBackend("a", 100);
    const sched = new Scheduler(new BackendRegistry().register("a", b), { tenantQuota: () => 3, ledger });
    const controller = new AbortController();
    const p = sched.dispatch(tjob("acme", "x"), { signal: controller.signal });
    await flush(); // pump reaches tryAdmit and parks on the gate
    controller.abort(); // the entry leaves the queue THROUGH onAbort while the claim is still in flight
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    ledger.releaseGate?.(); // the claim commits — too late to dispatch
    await flush();
    await flush();
    expect(b.dispatchedIds).toHaveLength(0); // the cancelled entry never reached the backend
    expect(ledger.permits.size).toBe(0); // the late-committed permit was returned, not held and renewed
  });

  it("dropping a queued entry returns the permit its lost-response claim left behind", async () => {
    // The lost-response shape: the ledger COMMITS the claim but the scheduler sees a refusal (the failure lands
    // between commit and response). The entry stays queued holding a REAL permit; a drop path that only refunds
    // the budget would strand that tenant slot until the reap.
    class LostResponseLedger extends PermitLedger {
      override async tryAdmit(tenant: string, permitId: string, quota: number): Promise<boolean> {
        await super.tryAdmit(tenant, permitId, quota);
        return false; // the committed claim's answer never arrives
      }
    }
    const ledger = new LostResponseLedger();
    const b = new ControlledBackend("a", 100);
    const sched = new Scheduler(new BackendRegistry().register("a", b), { tenantQuota: () => 3, ledger });
    const p = sched.dispatch(tjob("acme", "x"));
    await flush();
    expect(b.dispatchedIds).toHaveLength(0); // refused → still queued…
    expect(ledger.permits.size).toBe(1); // …but the claim committed

    const entry = sched.queueEntries()[0];
    expect(entry).toBeDefined();
    expect(sched.cancelEntry(entry?.id ?? "")).toBe(true);
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    await flush();
    expect(ledger.permits.size).toBe(0); // the drop returned the phantom permit
  });

  it('a ledger error is FAIL-CLOSED for quota\'d work — admitting on "could not check" is not a guarantee', async () => {
    const failing: AdmissionLedger = {
      inFlightByTenant: async () => ({}),
      tryAdmit: () => Promise.reject(new Error("database unreachable")),
      releaseAdmission: async () => {},
    };
    const b = new ControlledBackend("a", 100);
    const sched = new Scheduler(new BackendRegistry().register("a", b), { tenantQuota: () => 1, ledger: failing });
    void sched.dispatch(tjob("acme", "x"));
    await flush();
    expect(b.dispatchedIds).toHaveLength(0); // refused, still queued — never a silent over-admission
    expect(sched.stats().queued).toBe(1);
  });

  it("an unquota'd tenant never pays the permit round-trip — the limit binds only where one was stated", async () => {
    const ledger = new PermitLedger();
    const tryAdmitSpy = vi.spyOn(ledger, "tryAdmit");
    const b = new ControlledBackend("a", 100);
    const sched = new Scheduler(new BackendRegistry().register("a", b), { ledger });
    void sched.dispatch(tjob("acme", "x"));
    await flush();
    expect(b.dispatchedIds).toHaveLength(1);
    expect(tryAdmitSpy).not.toHaveBeenCalled();
  });

  it("one runtime's probe failure stops one runtime — the rest of the fleet keeps draining (H7)", async () => {
    // Regression: a tenant-registered runtime whose capacity probe throws (revoked K8s token, kubectl
    // missing on its lane) rejected the whole probe Promise.all — the drain died and EVERY backend's queue
    // stalled behind one bad registration. The failed backend is now simply absent from the capacity
    // snapshot: its own pinned job stays queued (fail-closed for that runtime), everything else places.
    class DeadProbeBackend extends ControlledBackend {
      override async capacity(): Promise<never> {
        throw new Error("Unauthorized: the cluster token was revoked");
      }
    }
    const dead = new DeadProbeBackend("dead", 5);
    const alive = new ControlledBackend("alive", 5);
    const sched = new Scheduler(new BackendRegistry().register("dead", dead).register("alive", alive));

    const pinnedToAlive = sched.dispatch(job("alive"));
    const pinnedToDead = sched.dispatch(job("dead"));
    void pinnedToDead.catch(() => {}); // stays queued in this test — never settled, never unhandled
    await flush();

    expect(alive.dispatchedIds).toHaveLength(1); // the healthy runtime drained normally
    expect(dead.dispatchedIds).toHaveLength(0); // nothing placed on the unprobeable runtime
    expect(sched.stats().queued).toBe(1); // its job waits for the next pump instead of killing this one

    alive.releaseAll();
    await flush();
    await expect(pinnedToAlive).resolves.toMatchObject({ harness: "alive" });
  });
});
