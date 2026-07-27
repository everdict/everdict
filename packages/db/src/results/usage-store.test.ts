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
  it("accumulates per (tenant, source, model) and returns every row via all()", async () => {
    const store = new InMemoryUsageStore();
    await store.record("acme", "harness", "opus", { usd: 0.1, tokens: 100 }, 1);
    await store.record("acme", "harness", "opus", { usd: 0.2, tokens: 200 }, 1);
    await store.record("acme", "harness", "haiku", { usd: 0.05, tokens: 50 }, 1); // different model → its own row
    await store.record("acme", "judge", "opus", { usd: 0.03, tokens: 30 }, 0);
    const rows = await store.all();
    const opus = rows.find((r) => r.source === "harness" && r.model === "opus");
    expect(opus?.usd).toBeCloseTo(0.3, 10);
    expect(opus).toMatchObject({ tenant: "acme", tokens: 300, evaluations: 2 });
    expect(rows.find((r) => r.source === "harness" && r.model === "haiku")).toMatchObject({ tokens: 50 });
    expect(rows.find((r) => r.source === "judge")).toMatchObject({
      model: "opus",
      usd: 0.03,
      tokens: 30,
      evaluations: 0,
    });
  });
});

describe("PgUsageStore", () => {
  it("record → an atomic ON CONFLICT increment on (tenant, source, model) with the right params", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [] }));
    await new PgUsageStore(client).record("acme", "harness", "opus", { usd: 0.1, tokens: 100 }, 1);
    expect(calls[0]?.text).toMatch(/INSERT INTO everdict_usage/);
    expect(calls[0]?.text).toMatch(/ON CONFLICT \(tenant, source, model\) DO UPDATE/);
    expect(calls[0]?.text).toMatch(/usd = everdict_usage\.usd \+ EXCLUDED\.usd/);
    expect(calls[0]?.params).toEqual(["acme", "harness", "opus", 0.1, 100, 1]);
  });

  it("all → coerces string numerics, keeps model, and normalizes the source (incl. agent)", async () => {
    const { client } = fakeClient(() => ({
      rows: [{ tenant: "acme", source: "agent", model: "opus", usd: "0.5", tokens: "300", evaluations: "2" }],
    }));
    const rows = await new PgUsageStore(client).all();
    expect(rows[0]).toEqual({ tenant: "acme", source: "agent", model: "opus", usd: 0.5, tokens: 300, evaluations: 2 });
  });
});
