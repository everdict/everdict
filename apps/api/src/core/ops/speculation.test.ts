import { CircuitBreaker } from "@everdict/backends";
import type { AgentJob, CaseResult } from "@everdict/core";
import { describe, expect, it } from "vitest";
import type { SpilloverOutcome } from "./runtime-spillover.js";
import { SpeculationController } from "./speculation.js";

const jobOn = (id: string, target: string): AgentJob => ({
  evalCase: {
    id,
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
    placement: { target },
  },
  harness: { id: "h", version: "1" },
  tenant: "acme",
});

const okResult = (caseId: string): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [{ graderId: "g", metric: "ok", value: 1, pass: true }],
});

// Manual clock + timer registry — advance() fires due timers and flushes microtasks.
function fakeTime() {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void; canceled: boolean }> = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): (() => void) => {
      const e = { at: t + ms, fn, canceled: false };
      timers.push(e);
      return () => {
        e.canceled = true;
      };
    },
    async advance(to: number): Promise<void> {
      t = to;
      // fire in scheduling order; a fired timer may arm a new one (due later)
      for (;;) {
        const due = timers.find((e) => !e.canceled && e.at <= t);
        if (!due) break;
        due.canceled = true;
        due.fn();
        await Promise.resolve();
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

// A controllable executor: each dispatch parks until released per target.
function fakeExecutor() {
  const dispatched: string[] = []; // "caseId@target"
  const parked = new Map<string, { resolve: (o: SpilloverOutcome) => void; reject: (e: unknown) => void }>();
  const execute = (job: AgentJob): Promise<SpilloverOutcome> => {
    const target = job.evalCase.placement?.target ?? "?";
    const key = `${job.evalCase.id}@${target}`;
    dispatched.push(key);
    return new Promise((resolve, reject) => parked.set(key, { resolve, reject }));
  };
  const release = (key: string, caseId: string, target: string): void => {
    parked.get(key)?.resolve({ result: okResult(caseId), target });
    parked.delete(key);
  };
  const fail = (key: string, e: unknown): void => {
    parked.get(key)?.reject(e);
    parked.delete(key);
  };
  return { execute, dispatched, release, fail };
}

const baseOpts = (time: ReturnType<typeof fakeTime>, breaker: CircuitBreaker, totalCases: number) => ({
  targets: ["slow-rt", "fast-rt"],
  tenant: "acme",
  breaker,
  totalCases,
  minStragglerMs: 1000,
  medianFactor: 2,
  rearmMs: 100,
  now: time.now,
  setTimer: time.setTimer,
});

describe("SpeculationController — tail straggler duplication", () => {
  it("duplicates a tail straggler onto the other runtime; the duplicate's result wins", async () => {
    const time = fakeTime();
    const breaker = new CircuitBreaker({ now: time.now });
    const exec = fakeExecutor();
    const speculations: string[] = [];
    const ctl = new SpeculationController({
      ...baseOpts(time, breaker, 2),
      onSpeculate: (cid, from, to) => speculations.push(`${cid}:${from}->${to}`),
    });

    const fast = ctl.run(exec.execute, jobOn("a", "fast-rt"));
    const slow = ctl.run(exec.execute, jobOn("b", "slow-rt"));
    await time.advance(200);
    exec.release("a@fast-rt", "a", "fast-rt"); // sibling completes at 200ms → median 200, threshold max(1000, 400)=1000
    await time.advance(300);
    expect(await fast).toMatchObject({ target: "fast-rt" });

    await time.advance(1500); // b has been in flight 1500ms > 1000 → duplicate fires
    expect(speculations).toEqual(["b:slow-rt->fast-rt"]);
    expect(exec.dispatched).toContain("b@fast-rt");
    exec.release("b@fast-rt", "b", "fast-rt"); // the duplicate lands first
    await time.advance(1501);
    const outcome = await slow;
    expect(outcome.target).toBe("fast-rt"); // winner = the speculated runtime
  });

  it("never speculates before every case has been dispatched (pure tail only)", async () => {
    const time = fakeTime();
    const breaker = new CircuitBreaker({ now: time.now });
    const exec = fakeExecutor();
    const ctl = new SpeculationController(baseOpts(time, breaker, 3)); // 3 cases total, only 1 started

    void ctl.run(exec.execute, jobOn("a", "slow-rt"));
    await time.advance(5000);
    expect(exec.dispatched).toEqual(["a@slow-rt"]); // re-armed polls, no duplicate
  });

  it("single-runtime batches are untouched", async () => {
    const time = fakeTime();
    const breaker = new CircuitBreaker({ now: time.now });
    const exec = fakeExecutor();
    const ctl = new SpeculationController({ ...baseOpts(time, breaker, 1), targets: ["only-rt"] });

    void ctl.run(exec.execute, jobOn("a", "only-rt"));
    await time.advance(60_000);
    expect(exec.dispatched).toEqual(["a@only-rt"]);
  });

  it("the primary winning after a duplicate fired discards the duplicate", async () => {
    const time = fakeTime();
    const breaker = new CircuitBreaker({ now: time.now });
    const exec = fakeExecutor();
    const ctl = new SpeculationController(baseOpts(time, breaker, 1));

    const p = ctl.run(exec.execute, jobOn("a", "slow-rt"));
    await time.advance(1200); // no median yet → floor 1000ms → duplicate fired
    expect(exec.dispatched).toEqual(["a@slow-rt", "a@fast-rt"]);
    exec.release("a@slow-rt", "a", "slow-rt"); // primary lands first after all
    const outcome = await p;
    expect(outcome.target).toBe("slow-rt");
    exec.release("a@fast-rt", "a", "fast-rt"); // late loser — silently discarded
    await time.advance(1300);
  });

  it("when the duplicate wins, the (possibly still-queued) loser is reclaimed via cancelQueued", async () => {
    const time = fakeTime();
    const breaker = new CircuitBreaker({ now: time.now });
    const exec = fakeExecutor();
    const reclaimed: string[] = [];
    const ctl = new SpeculationController({
      ...baseOpts(time, breaker, 1),
      cancelQueued: (cid) => reclaimed.push(cid),
    });

    const p = ctl.run(exec.execute, jobOn("a", "slow-rt"));
    await time.advance(1200); // duplicate fired
    exec.release("a@fast-rt", "a", "fast-rt"); // duplicate wins while the primary is still pending
    const outcome = await p;
    expect(outcome.target).toBe("fast-rt");
    expect(reclaimed).toEqual(["a"]); // the loser's queued entry gets cancelled at the scheduler
  });

  it("seedMedianMs sets the threshold before any sibling completes (the lone straggler doesn't wait for the bare floor)", async () => {
    const time = fakeTime();
    const breaker = new CircuitBreaker({ now: time.now });
    const exec = fakeExecutor();
    // Historical median 3s → threshold max(minStragglerMs=1000, 2×3000) = 6000ms — ABOVE the floor, so the
    // duplicate must NOT fire at 1s (the un-seeded behavior) and MUST fire past 6s.
    const ctl = new SpeculationController({ ...baseOpts(time, breaker, 1), seedMedianMs: 3000 });
    void ctl.run(exec.execute, jobOn("a", "slow-rt"));
    await time.advance(1200);
    expect(exec.dispatched).toEqual(["a@slow-rt"]); // floor alone would have fired here
    await time.advance(6200);
    expect(exec.dispatched).toEqual(["a@slow-rt", "a@fast-rt"]); // seed-informed threshold fired
  });

  it("does not speculate onto an open circuit", async () => {
    const time = fakeTime();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000, now: time.now });
    breaker.failure("acme:fast-rt"); // the only alternative is open
    const exec = fakeExecutor();
    const ctl = new SpeculationController(baseOpts(time, breaker, 1));

    void ctl.run(exec.execute, jobOn("a", "slow-rt"));
    await time.advance(5000);
    expect(exec.dispatched).toEqual(["a@slow-rt"]);
  });

  it("a primary failure after the duplicate joined doesn't fail the case — the duplicate's result lands", async () => {
    const time = fakeTime();
    const breaker = new CircuitBreaker({ now: time.now });
    const exec = fakeExecutor();
    const ctl = new SpeculationController(baseOpts(time, breaker, 1));

    const p = ctl.run(exec.execute, jobOn("a", "slow-rt"));
    await time.advance(1200); // duplicate fired
    exec.fail("a@slow-rt", new Error("primary died late"));
    exec.release("a@fast-rt", "a", "fast-rt");
    const outcome = await p;
    expect(outcome.target).toBe("fast-rt");
  });
});
