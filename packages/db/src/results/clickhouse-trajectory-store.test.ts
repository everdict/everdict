import { describe, expect, it } from "vitest";
import { ClickHouseTrajectoryStore } from "./clickhouse-trajectory-store.js";

// The HTTP interface is the contract — a fake fetch captures each request's query/params/body and serves
// canned JSONEachRow lines, so the SQL shapes and the read-side first-write-wins are pinned without a server.
function fakeClickHouse(handler: (sql: string, params: URLSearchParams, body: string) => string | undefined) {
  const calls: Array<{ sql: string; params: URLSearchParams; body: string }> = [];
  const fetchImpl = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    const sql = url.searchParams.get("query") ?? "";
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ sql, params: url.searchParams, body });
    const out = handler(sql, url.searchParams, body);
    return new Response(out ?? "", { status: out === undefined ? 500 : 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const metaLine = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    run_id: "r1",
    tenant: "acme",
    source: "otlp",
    event_count: 2,
    body: JSON.stringify([{ t: 0, kind: "llm_call", model: "m" }]),
    sealed_at: "2026-07-30T00:00:00.000Z",
    ...over,
  })}\n`;

const listLine = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    run_id: "r1",
    tenant_first: "acme",
    source_first: "otlp",
    event_count_first: 2,
    sealed_at_first: "2026-07-30T00:00:00.000Z",
    ...over,
  })}\n`;

describe("ClickHouseTrajectoryStore — the ops-scale rung behind the SAME port (N3)", () => {
  it("seal is check-then-insert: absent → JSONEachRow INSERT with created:true; present → the FIRST seal's meta, created:false", async () => {
    let stored: string | undefined;
    const { calls, fetchImpl } = fakeClickHouse((sql, _params, body) => {
      if (sql.startsWith("SELECT")) return stored ?? "";
      if (sql.startsWith("INSERT")) {
        stored = `${body}\n`;
        return "";
      }
      return "";
    });
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    const first = await store.seal({
      runId: "r1",
      tenant: "acme",
      source: "otlp",
      events: [{ t: 0, kind: "llm_call", model: "m" }],
    });
    expect(first.created).toBe(true);
    expect(calls.some((c) => c.sql.includes("INSERT INTO default.everdict_trajectories FORMAT JSONEachRow"))).toBe(
      true,
    );

    const again = await store.seal({ runId: "r1", tenant: "acme", source: "run", events: [] });
    expect(again).toMatchObject({ created: false, source: "otlp", eventCount: 1 }); // the first seal's meta
  });

  it("reads resolve first-write-wins (earliest sealed_at) and stay tenant-scoped; values travel as bound params", async () => {
    const { calls, fetchImpl } = fakeClickHouse((sql) => (sql.startsWith("SELECT") ? metaLine() : ""));
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    const hit = await store.get("acme", "r1");
    expect(hit?.meta).toMatchObject({ runId: "r1", source: "otlp", eventCount: 2 });
    expect(hit?.events).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/ORDER BY sealed_at ASC LIMIT 1/); // the read-side half of first-write-wins
    expect(calls[0]?.params.get("param_runId")).toBe("r1"); // bound, never concatenated

    expect(await store.get("rival", "r1")).toBeUndefined(); // tenant check after the point read
  });

  it("list dedups per run (argMin), pages by keyset cursor; meter and retention ride the same dedup", async () => {
    const { calls, fetchImpl } = fakeClickHouse((sql) => {
      if (sql.includes("argMin(tenant"))
        return listLine() + listLine({ run_id: "r0", sealed_at_first: "2026-07-29T00:00:00.000Z" });
      if (sql.includes("count() AS trajectories")) return `${JSON.stringify({ trajectories: "3", events: "9" })}\n`;
      if (sql.includes("count(DISTINCT run_id)")) return `${JSON.stringify({ trajectories: "2" })}\n`;
      return "";
    });
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    const page = await store.list("acme", { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const listSql = calls[0]?.sql ?? "";
    expect(listSql).toMatch(/argMin\(source, sealed_at\) AS source_first/); // *_first: a CH alias shadows its column everywhere in the SELECT
    expect(listSql).toMatch(/GROUP BY run_id/);

    await store.list("acme", { limit: 1, cursor: page.nextCursor ?? "" });
    expect(calls[1]?.sql).toMatch(/HAVING \(sealed_at_first, run_id\) </);

    expect(await store.ingestedSince("acme", "2026-07-30T00:00:00.000Z")).toEqual({ trajectories: 3, events: 9 });

    expect(await store.deleteOlderThan("2026-07-01T00:00:00.000Z")).toBe(2);
    const deleteCall = calls.find((c) => c.sql.startsWith("DELETE"));
    expect(deleteCall?.sql).toMatch(/DELETE FROM default.everdict_trajectories WHERE sealed_at < \{cutoff:String\}/);
  });

  it("a ClickHouse failure is remapped to UPSTREAM_ERROR (never a raw fetch error across the boundary)", async () => {
    const { fetchImpl } = fakeClickHouse(() => undefined); // 500
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);
    await expect(store.get("acme", "r1")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});
