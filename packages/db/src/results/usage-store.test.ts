import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryUsageStore, PgUsageStore } from "./usage-store.js";

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

describe("InMemoryUsageStore", () => {
  it("accumulates per (tenant, source) and returns every row via all()", async () => {
    const store = new InMemoryUsageStore();
    await store.record("acme", "harness", { usd: 0.1, tokens: 100 }, 1);
    await store.record("acme", "harness", { usd: 0.2, tokens: 200 }, 1);
    await store.record("acme", "judge", { usd: 0.03, tokens: 30 }, 0);
    const rows = await store.all();
    const harness = rows.find((r) => r.source === "harness");
    expect(harness?.usd).toBeCloseTo(0.3, 10);
    expect(harness).toMatchObject({ tenant: "acme", tokens: 300, evaluations: 2 });
    expect(rows.find((r) => r.source === "judge")).toMatchObject({ usd: 0.03, tokens: 30, evaluations: 0 });
  });
});

describe("PgUsageStore", () => {
  it("record → an atomic ON CONFLICT increment with the right params", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgUsageStore(client).record("acme", "harness", { usd: 0.1, tokens: 100 }, 1);
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_usage/);
    expect(calls[0]?.text).toMatch(/ON CONFLICT \(tenant, source\) DO UPDATE/);
    expect(calls[0]?.text).toMatch(/usd = everdict_usage\.usd \+ EXCLUDED\.usd/);
    expect(calls[0]?.params).toEqual(["acme", "harness", 0.1, 100, 1]);
  });

  it("all → coerces string numerics and normalizes the source", async () => {
    const { client } = fakeClient(() => ({
      rows: [{ tenant: "acme", source: "harness", usd: "0.5", tokens: "300", evaluations: "2" }],
    }));
    const rows = await new PgUsageStore(client).all();
    expect(rows[0]).toEqual({ tenant: "acme", source: "harness", usd: 0.5, tokens: 300, evaluations: 2 });
  });
});
