import type { CaseResult } from "@everdict/core";
import { InMemoryUsageStore, type UsageStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { persistentUsageMeter } from "./usage-meter.js";

const result = (usd: number, tokens: number, provenance?: CaseResult["provenance"]): CaseResult => ({
  caseId: "c1",
  harness: "h@1",
  trace: [{ t: 0, kind: "llm_call", model: "m", cost: { usd, inputTokens: tokens, outputTokens: 0 } }],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
  ...(provenance ? { provenance } : {}),
});

// let fire-and-forget persistence settle
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("persistentUsageMeter", () => {
  it("write-throughs record to the store and reflects it in usage()", async () => {
    const store = new InMemoryUsageStore();
    const meter = persistentUsageMeter(store);
    meter.record("acme", "harness", { usd: 0.1, tokens: 100 }, 1);
    expect(meter.usage("acme")).toMatchObject({ usd: 0.1, tokens: 100, evaluations: 1 });
    await flush();
    expect(await store.all()).toContainEqual({
      tenant: "acme",
      source: "harness",
      usd: 0.1,
      tokens: 100,
      evaluations: 1,
    });
  });

  it("meterCase persists the harness cost, and an own-pays run is skipped", async () => {
    const store = new InMemoryUsageStore();
    const meter = persistentUsageMeter(store);
    meter.meterCase(result(0.05, 200), "acme");
    await flush();
    expect(await store.all()).toContainEqual({
      tenant: "acme",
      source: "harness",
      usd: 0.05,
      tokens: 200,
      evaluations: 1,
    });
    // personal self-hosted (own-pays) → not metered / not persisted
    meter.meterCase(result(0.05, 200, { ranOn: "self-hosted", by: "u-alice" }), "acme");
    await flush();
    expect(await store.all()).toHaveLength(1);
  });

  it("hydrate restores in-memory usage from the store at boot", async () => {
    const store = new InMemoryUsageStore();
    await store.record("acme", "harness", { usd: 0.4, tokens: 400 }, 3);
    await store.record("acme", "judge", { usd: 0.02, tokens: 20 }, 0);
    const meter = persistentUsageMeter(store);
    expect(meter.usage("acme")).toMatchObject({ usd: 0, evaluations: 0 }); // empty before hydrate
    await meter.hydrate();
    const u = meter.usage("acme");
    expect(u).toMatchObject({ tokens: 420, evaluations: 3 });
    expect(u.usd).toBeCloseTo(0.42, 10);
    expect(u.bySource.harness).toMatchObject({ usd: 0.4, tokens: 400, evaluations: 3 });
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
    expect(() => meter.record("acme", "harness", { usd: 1, tokens: 1 }, 1)).not.toThrow();
    expect(meter.usage("acme").usd).toBe(1);
    await flush();
  });
});
