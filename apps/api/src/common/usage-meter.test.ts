import { InMemoryUsageStore, type UsageStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { persistentUsageMeter } from "./usage-meter.js";

// let fire-and-forget persistence settle
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("persistentUsageMeter", () => {
  it("write-throughs record to the store (day-stamped) and reflects it in usage()", async () => {
    const store = new InMemoryUsageStore();
    const meter = persistentUsageMeter(store);
    meter.record("acme", "harness", "opus", { usd: 0.1, tokens: 100 }, 1);
    expect(meter.usage("acme")).toMatchObject({ usd: 0.1, tokens: 100, evaluations: 1 });
    await flush();
    expect(await store.all()).toContainEqual({
      tenant: "acme",
      source: "harness",
      model: "opus",
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), // stamped once, shared by meter + store
      usd: 0.1,
      tokens: 100,
      evaluations: 1,
    });
  });

  it("hydrate restores in-memory usage (incl. per-model items and the daily series) from the store at boot", async () => {
    const store = new InMemoryUsageStore();
    await store.record("acme", "harness", "opus", "2026-07-27", { usd: 0.4, tokens: 400 }, 3);
    await store.record("acme", "judge", "haiku", "2026-07-28", { usd: 0.02, tokens: 20 }, 0);
    const meter = persistentUsageMeter(store);
    expect(meter.usage("acme")).toMatchObject({ usd: 0, evaluations: 0 }); // empty before hydrate
    await meter.hydrate();
    const u = meter.usage("acme");
    expect(u).toMatchObject({ tokens: 420, evaluations: 3 });
    expect(u.usd).toBeCloseTo(0.42, 10);
    expect(u.bySource.harness).toMatchObject({ usd: 0.4, tokens: 400, evaluations: 3 });
    expect(u.items).toContainEqual({ source: "harness", model: "opus", usd: 0.4, tokens: 400, evaluations: 3 });
    expect(u.items).toContainEqual({ source: "judge", model: "haiku", usd: 0.02, tokens: 20, evaluations: 0 });
    expect(u.daily).toEqual([
      { day: "2026-07-27", source: "harness", model: "opus", usd: 0.4, tokens: 400, evaluations: 3 },
      { day: "2026-07-28", source: "judge", model: "haiku", usd: 0.02, tokens: 20, evaluations: 0 },
    ]);
  });

  it("a failing store never throws from record (best-effort persistence; in-memory still updates)", async () => {
    const store: UsageStore = {
      async record() {
        throw new Error("db down");
      },
      async all() {
        return [];
      },
    };
    const meter = persistentUsageMeter(store);
    expect(() => meter.record("acme", "harness", "opus", { usd: 1, tokens: 1 }, 1)).not.toThrow();
    expect(meter.usage("acme").usd).toBe(1);
    await flush();
  });
});
