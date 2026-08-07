import { describe, expect, it } from "vitest";
import { type PoolAutoscalerHost, type ScalablePool, TopologyPoolAutoscaler } from "./pool-autoscaler.js";

// The actuation half of elastic capacity: session-pool saturation + that harness's backlog drive the session
// service's replica count between the harness-declared bounds. Sessions translate to replicas via the pool's
// own per-replica ratio (total ÷ current replicas).
describe("TopologyPoolAutoscaler", () => {
  const scalable = (over: {
    key?: string;
    pool: { total: number; used?: number };
    bounds?: { min: number; max: number };
    replicas: { value: number | undefined };
    scaled: number[];
  }): ScalablePool => ({
    key: over.key ?? "bu@1.0.0",
    bounds: over.bounds ?? { min: 1, max: 4 },
    pool: over.pool,
    target: {
      id: over.key ?? "bu@1.0.0",
      current: () => {
        if (over.replicas.value === undefined) throw new Error("unreadable");
        return over.replicas.value;
      },
      scaleTo: (desired) => {
        over.scaled.push(desired);
        over.replicas.value = desired;
      },
    },
  });
  const hostOf = (pools: () => ScalablePool[]): PoolAutoscalerHost => ({ poolScalingTargets: pools });

  it("scales the session service up immediately when the pool saturates with backlog behind it", async () => {
    const scaled: number[] = [];
    const replicas = { value: 1 };
    const events: string[] = [];
    let poked = 0;
    const manager = new TopologyPoolAutoscaler({
      hosts: () => [hostOf(() => [scalable({ pool: { total: 8, used: 8 }, replicas, scaled })])],
      queuedFor: () => 8, // 8 running + 8 waiting = 16 sessions of demand at 8 sessions/replica → 2 replicas
      onScale: (key, from, to) => events.push(`${key}:${from}->${to}`),
      onScaled: () => {
        poked += 1;
      },
    });

    await manager.tick();

    expect(scaled).toEqual([2]);
    expect(events).toEqual(["bu@1.0.0:1->2"]);
    expect(poked).toBe(1); // the scheduler re-pumps so the new capacity drains the queue
  });

  it("clamps to the harness-declared max — the burst never outgrows what the author said the service can hold", async () => {
    const scaled: number[] = [];
    const replicas = { value: 1 };
    const manager = new TopologyPoolAutoscaler({
      hosts: () => [hostOf(() => [scalable({ pool: { total: 8, used: 8 }, replicas, scaled })])],
      queuedFor: () => 1000,
    });

    await manager.tick();

    expect(scaled).toEqual([4]); // bounds.max, not demand/perReplica
  });

  it("holds position when the pool is busy but nothing waits — saturation alone is not demand for MORE", async () => {
    const scaled: number[] = [];
    const replicas = { value: 1 };
    const manager = new TopologyPoolAutoscaler({
      hosts: () => [hostOf(() => [scalable({ pool: { total: 8, used: 8 }, replicas, scaled })])],
      queuedFor: () => 0, // 8 in use / 8 per replica = exactly the current 1 replica
    });

    await manager.tick();
    await manager.tick();

    expect(scaled).toEqual([]);
  });

  it("scales down only after the idle hysteresis — a lull between waves must not thrash the service", async () => {
    const scaled: number[] = [];
    const replicas = { value: 2 };
    const pool = { total: 16, used: 0 as number | undefined };
    const manager = new TopologyPoolAutoscaler({
      hosts: () => [hostOf(() => [scalable({ pool, replicas, scaled })])],
      queuedFor: () => 0,
      scaleDownAfterTicks: 2,
    });

    await manager.tick(); // idle tick 1 — no action yet
    expect(scaled).toEqual([]);
    await manager.tick(); // idle tick 2 — hysteresis satisfied
    expect(scaled).toEqual([1]); // down to bounds.min
  });

  it("one pool's unreadable replica count skips its tick without stalling the others", async () => {
    const scaledA: number[] = [];
    const scaledB: number[] = [];
    const manager = new TopologyPoolAutoscaler({
      hosts: () => [
        hostOf(() => [
          scalable({ key: "a@1", pool: { total: 8, used: 8 }, replicas: { value: undefined }, scaled: scaledA }),
          scalable({ key: "b@1", pool: { total: 8, used: 8 }, replicas: { value: 1 }, scaled: scaledB }),
        ]),
      ],
      queuedFor: () => 8,
    });

    await manager.tick();

    expect(scaledA).toEqual([]); // blind — never acts
    expect(scaledB).toEqual([2]);
  });

  it("a pool that vanishes (warm sweep) takes its hysteresis state with it", async () => {
    const scaled: number[] = [];
    const replicas = { value: 2 };
    let present = true;
    const manager = new TopologyPoolAutoscaler({
      hosts: () => [hostOf(() => (present ? [scalable({ pool: { total: 16, used: 0 }, replicas, scaled })] : []))],
      queuedFor: () => 0,
      scaleDownAfterTicks: 2,
    });

    await manager.tick(); // idle tick 1 accumulates
    present = false;
    await manager.tick(); // gone — state dropped
    present = true;
    await manager.tick(); // back: hysteresis restarts from zero → still no downscale
    expect(scaled).toEqual([]);
    await manager.tick(); // second consecutive idle tick since return → now it acts
    expect(scaled).toEqual([1]);
  });

  it("a pool that reports no `used` counts as full — backlog scales it up, idleness cannot be proven so it never shrinks", async () => {
    const scaled: number[] = [];
    const replicas = { value: 1 };
    const manager = new TopologyPoolAutoscaler({
      hosts: () => [hostOf(() => [scalable({ pool: { total: 8 }, replicas, scaled })])],
      queuedFor: () => 8,
      scaleDownAfterTicks: 1,
    });

    await manager.tick();
    expect(scaled).toEqual([2]); // (8 assumed held + 8 queued) / 8 per replica

    // Demand gone: assumed-full pool now reads 16 sessions across 2 replicas → exactly current — no shrink.
    const manager2 = new TopologyPoolAutoscaler({
      hosts: () => [hostOf(() => [scalable({ pool: { total: 16 }, replicas, scaled })])],
      queuedFor: () => 0,
      scaleDownAfterTicks: 1,
    });
    await manager2.tick();
    await manager2.tick();
    expect(scaled).toEqual([2]);
  });
});
