import { describe, expect, it } from "vitest";
import { Autoscaler, MutableSlots, aggregateLoad, desiredCapacity } from "./autoscaler.js";

const policy = { min: 1, max: 4 };

describe("desiredCapacity", () => {
  it("with a backlog, targets demand (inFlight+queued), clamped to max", () => {
    expect(desiredCapacity({ queued: 7, inFlight: 1 }, 1, policy)).toBe(4); // demand 8 → max 4
    expect(desiredCapacity({ queued: 2, inFlight: 1 }, 1, policy)).toBe(3);
  });
  it("fully idle → min", () => {
    expect(desiredCapacity({ queued: 0, inFlight: 0 }, 4, policy)).toBe(1);
    expect(desiredCapacity({ queued: 0, inFlight: 0 }, 4, { min: 0, max: 4 })).toBe(0); // scale-to-zero
  });
  it("over-provisioned (in-flight < current, 0 queued) → drops to the in-flight level", () => {
    expect(desiredCapacity({ queued: 0, inFlight: 2 }, 4, policy)).toBe(2);
  });
});

describe("Autoscaler.tick", () => {
  it("upscales immediately when a backlog appears and wakes the scheduler via onChanged", async () => {
    const slots = new MutableSlots("nomad", 1);
    const scales: Array<[string, number, number]> = [];
    let poked = 0;
    const auto = new Autoscaler({
      signal: () => ({ queued: 7, inFlight: 1 }),
      targets: [slots],
      policy,
      onScale: (id, from, to) => scales.push([id, from, to]),
      onChanged: () => poked++,
    });
    await auto.tick();
    expect(slots.current()).toBe(4); // 1 → 4 immediately
    expect(scales).toEqual([["nomad", 1, 4]]);
    expect(poked).toBe(1);
  });

  it("downscales only after hysteresis (N consecutive ticks) — anti-flapping", async () => {
    const slots = new MutableSlots("nomad", 4);
    const auto = new Autoscaler({
      signal: () => ({ queued: 0, inFlight: 0 }), // idle → desired=min=1 < 4
      targets: [slots],
      policy: { min: 1, max: 4, scaleDownAfterTicks: 3 },
    });
    await auto.tick();
    expect(slots.current()).toBe(4); // not yet (tick 1)
    await auto.tick();
    expect(slots.current()).toBe(4); // not yet (tick 2)
    await auto.tick();
    expect(slots.current()).toBe(1); // tick 3 → drops
  });

  it("an upscale resets the down counter", async () => {
    const slots = new MutableSlots("nomad", 2);
    let load = { queued: 0, inFlight: 0 };
    const auto = new Autoscaler({
      signal: () => load,
      targets: [slots],
      policy: { min: 1, max: 4, scaleDownAfterTicks: 2 },
    });
    await auto.tick(); // down candidate, tick 1 (still 2)
    load = { queued: 5, inFlight: 0 };
    await auto.tick(); // upscale → counter reset, to 4
    expect(slots.current()).toBe(4);
    load = { queued: 0, inFlight: 0 };
    await auto.tick(); // down candidate, tick 1 (reset, so not down yet)
    expect(slots.current()).toBe(4);
  });
});

describe("aggregateLoad", () => {
  it("sums per-backend in-flight", () => {
    expect(aggregateLoad({ queued: 3, inFlight: { a: 2, b: 1 } })).toEqual({ queued: 3, inFlight: 3 });
  });
});
