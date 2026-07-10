import { PaymentRequiredError } from "@everdict/contracts";
import type { BudgetLimitRow, BudgetStore, BudgetUsageRow } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { persistentBudget } from "./budget-tracker.js";

type UsageDelta = { runs?: number; usd?: number; tokens?: number };

// A fake BudgetStore that records write-throughs and returns seeded rows for hydration.
function fakeStore(seed?: { usage?: BudgetUsageRow[]; limits?: BudgetLimitRow[] }): BudgetStore & {
  addUsageCalls: Array<{ tenant: string; delta: UsageDelta }>;
  setLimitCalls: Array<{ tenant: string; limit: UsageDelta }>;
} {
  const addUsageCalls: Array<{ tenant: string; delta: UsageDelta }> = [];
  const setLimitCalls: Array<{ tenant: string; limit: UsageDelta }> = [];
  return {
    addUsageCalls,
    setLimitCalls,
    async addUsage(tenant, delta) {
      addUsageCalls.push({ tenant, delta });
    },
    async allUsage() {
      return seed?.usage ?? [];
    },
    async setLimit(tenant, limit) {
      setLimitCalls.push({ tenant, limit });
    },
    async allLimits() {
      return seed?.limits ?? [];
    },
  };
}

describe("persistentBudget", () => {
  it("hydrates durable usage and limits into memory at boot", async () => {
    const store = fakeStore({
      usage: [{ tenant: "acme", runs: 2, usd: 5, tokens: 500 }],
      limits: [{ tenant: "acme", runs: 3 }],
    });
    const b = persistentBudget(store);
    await b.hydrate();

    expect(b.usage("acme")).toEqual({ usd: 5, tokens: 500, runs: 2 });
    expect(b.limitOf("acme")).toEqual({ runs: 3 });
    b.admit("acme"); // runs 2 → 3 (still within the cap of 3, checked before reserving)
    expect(() => b.admit("acme")).toThrow(PaymentRequiredError); // now at the cap
  });

  it("writes admit / settle / release deltas through to the store (best-effort, synchronous record)", async () => {
    const store = fakeStore();
    const b = persistentBudget(store);
    b.admit("t");
    b.settle("t", { usd: 0.5, tokens: 100 });
    b.release("t");
    expect(store.addUsageCalls).toEqual([
      { tenant: "t", delta: { runs: 1 } },
      { tenant: "t", delta: { usd: 0.5, tokens: 100 } },
      { tenant: "t", delta: { runs: -1 } },
    ]);
  });

  it("enforces the env fallback until a stored limit overrides it (DB precedence)", async () => {
    const store = fakeStore();
    const b = persistentBudget(store, { fallback: (t) => (t === "acme" ? { runs: 1 } : undefined) });
    b.admit("acme"); // runs 1 — at the fallback cap
    expect(() => b.admit("acme")).toThrow(PaymentRequiredError); // env fallback enforced

    await b.setLimit("acme", { runs: 5 }); // an admin raises the cap
    expect(b.limitOf("acme")).toEqual({ runs: 5 }); // stored limit now takes precedence
    expect(store.setLimitCalls).toContainEqual({ tenant: "acme", limit: { runs: 5 } });
    expect(() => b.admit("acme")).not.toThrow(); // headroom under the new cap
  });
});
