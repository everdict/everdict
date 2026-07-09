import { describe, expect, it } from "vitest";
import { InMemoryBudgetStore, PgBudgetStore } from "./budget-store.js";
import type { SqlClient } from "./client.js";

function fakeClient(handler: (text: string, params?: unknown[]) => { rows: unknown[] }): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    client: {
      async query(text, params) {
        calls.push({ text, params });
        return handler(text, params) as { rows: never[] };
      },
    },
  };
}

describe("InMemoryBudgetStore", () => {
  it("accumulates usage deltas per tenant and floors runs at 0", async () => {
    const store = new InMemoryBudgetStore();
    await store.addUsage("acme", { runs: 1 });
    await store.addUsage("acme", { runs: 1, usd: 0.1, tokens: 100 });
    await store.addUsage("acme", { runs: -1 }); // a release
    const [row] = await store.allUsage();
    expect(row).toMatchObject({ tenant: "acme", runs: 1, tokens: 100 });
    expect(row?.usd).toBeCloseTo(0.1, 10);

    await store.addUsage("acme", { runs: -5 }); // release more than reserved
    expect((await store.allUsage())[0]?.runs).toBe(0); // floored, never negative
  });

  it("stores per-tenant limits with a PUT replacing the whole limit (unset dimension = unlimited)", async () => {
    const store = new InMemoryBudgetStore();
    await store.setLimit("acme", { usd: 100, runs: 500 });
    expect(await store.allLimits()).toEqual([{ tenant: "acme", usd: 100, runs: 500 }]);
    await store.setLimit("acme", { tokens: 1_000_000 }); // replace → usd/runs cleared (now unlimited)
    expect(await store.allLimits()).toEqual([{ tenant: "acme", tokens: 1_000_000 }]);
  });
});

describe("PgBudgetStore", () => {
  it("addUsage → an atomic ON CONFLICT increment, runs guarded with GREATEST(0, …)", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgBudgetStore(client).addUsage("acme", { runs: 1, usd: 0.2, tokens: 200 });
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_budget_usage/);
    expect(calls[0]?.text).toMatch(/ON CONFLICT \(tenant\) DO UPDATE/);
    expect(calls[0]?.text).toMatch(/runs = GREATEST\(0, everdict_budget_usage\.runs \+ EXCLUDED\.runs\)/);
    expect(calls[0]?.params).toEqual(["acme", 1, 0.2, 200]);
  });

  it("setLimit → passes NULL for an unset dimension so it reads as unlimited", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgBudgetStore(client).setLimit("acme", { runs: 500 }); // usd/tokens unset
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_budget_limits/);
    expect(calls[0]?.params).toEqual(["acme", null, null, 500]);
  });

  it("allUsage / allLimits coerce pg string numerics and drop NULL limit dimensions", async () => {
    const usage = fakeClient(() => ({ rows: [{ tenant: "acme", runs: "3", usd: "0.5", tokens: "300" }] }));
    expect(await new PgBudgetStore(usage.client).allUsage()).toEqual([
      { tenant: "acme", runs: 3, usd: 0.5, tokens: 300 },
    ]);
    const limits = fakeClient(() => ({ rows: [{ tenant: "acme", usd: "100", tokens: null, runs: "500" }] }));
    expect(await new PgBudgetStore(limits.client).allLimits()).toEqual([{ tenant: "acme", usd: 100, runs: 500 }]);
  });
});
