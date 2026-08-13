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

// One segment of a trajectory as the per-emitter read returns it (argMin-resolved, *_first aliases).
const segmentLine = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    emitter: "otlp",
    tenant_first: "acme",
    source_first: "otlp",
    event_count_first: 2,
    body_first: JSON.stringify([{ t: 0, kind: "llm_call", model: "m" }]),
    t0_first: "",
    sealed_at_first: "2026-07-30T00:00:00.000Z",
    ...over,
  })}\n`;

const listLine = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    run_id: "r1",
    tenant_run: "acme",
    source_run: "otlp",
    event_count_run: 2,
    sealed_at_run: "2026-07-30T00:00:00.000Z",
    ...over,
  })}\n`;

describe("ClickHouseTrajectoryStore — the ops-scale rung behind the SAME port (N3)", () => {
  it("seals once per emitter: a new emitter INSERTs a plane, a re-offer of the same one writes nothing", async () => {
    const rows: string[] = [];
    const { calls, fetchImpl } = fakeClickHouse((sql, _params, body) => {
      if (sql.includes("GROUP BY emitter")) return rows.join("");
      if (sql.includes("SELECT run_id FROM")) return rows.length > 0 ? `${JSON.stringify({ run_id: "r1" })}\n` : "";
      if (sql.startsWith("INSERT")) {
        const row = JSON.parse(body) as Record<string, unknown>;
        rows.push(
          segmentLine({
            emitter: row.emitter,
            source_first: row.source,
            event_count_first: row.event_count,
            body_first: row.body,
          }),
        );
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

    const again = await store.seal({ runId: "r1", tenant: "acme", source: "otlp", events: [] });
    expect(again).toMatchObject({ created: false, source: "otlp" }); // the first seal's meta

    // A SERVICE is a different emitter — it joins as its own plane rather than losing as a duplicate.
    const service = await store.seal({
      runId: "r1",
      tenant: "acme",
      source: "otlp",
      emitter: "service:checkout",
      events: [{ t: 0, kind: "span", name: "GET /cart", durationMs: 4 }],
    });
    expect(service.created).toBe(true);
  });

  it("reads resolve first-write-wins per emitter and stay tenant-scoped; values travel as bound params", async () => {
    const { calls, fetchImpl } = fakeClickHouse((sql) =>
      sql.includes("GROUP BY emitter")
        ? segmentLine() +
          segmentLine({
            emitter: "service:checkout",
            event_count_first: 1,
            body_first: JSON.stringify([{ t: 0, kind: "span", name: "GET /cart" }]),
            sealed_at_first: "2026-07-30T00:00:05.000Z",
          })
        : "",
    );
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    const hit = await store.get("acme", "r1");
    expect(hit?.meta).toMatchObject({ runId: "r1", source: "otlp", eventCount: 3 }); // every plane counted
    expect(hit?.segments.map((s) => s.emitter)).toEqual(["otlp", "service:checkout"]);
    expect(hit?.executionEmitter).toBe("otlp");
    expect(hit?.events).toHaveLength(1); // the execution's own record, not the service's
    expect(calls[0]?.sql).toMatch(/ORDER BY sealed_at_first ASC/); // the read-side half of first-write-wins
    expect(calls[0]?.params.get("param_runId")).toBe("r1"); // bound, never concatenated

    expect(await store.get("rival", "r1")).toBeUndefined(); // tenant check after the point read
  });

  it("list dedups per (run, emitter), pages by keyset cursor; meter and retention ride the same dedup", async () => {
    const { calls, fetchImpl } = fakeClickHouse((sql) => {
      if (sql.includes("argMin(tenant_first"))
        return listLine() + listLine({ run_id: "r0", sealed_at_run: "2026-07-29T00:00:00.000Z" });
      if (sql.includes("sum(event_count_run) AS events"))
        return `${JSON.stringify({ trajectories: "3", events: "9" })}\n`;
      if (sql.includes("count() AS trajectories")) return `${JSON.stringify({ trajectories: "2" })}\n`;
      return "";
    });
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    const page = await store.list("acme", { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const listSql = calls[0]?.sql ?? "";
    expect(listSql).toMatch(/argMin\(source, sealed_at\) AS source_first/); // *_first: a CH alias shadows its column everywhere in the SELECT
    expect(listSql).toMatch(/GROUP BY run_id, emitter/); // the per-plane dedup the run-level aggregate sits on
    expect(listSql).toMatch(/sum\(event_count_first\) AS event_count_run/); // a run's planes counted together

    await store.list("acme", { limit: 1, cursor: page.nextCursor ?? "" });
    expect(calls[1]?.sql).toMatch(/HAVING \(sealed_at_run, run_id\) </);

    expect(await store.ingestedSince("acme", "2026-07-30T00:00:00.000Z")).toEqual({ trajectories: 3, events: 9 });

    expect(await store.deleteOlderThan("2026-07-01T00:00:00.000Z")).toBe(2);
    const deleteCall = calls.find((c) => c.sql.startsWith("DELETE"));
    // Retention cuts by the TRAJECTORY's earliest seal — never orphaning a run's later plane.
    expect(deleteCall?.sql).toMatch(/DELETE FROM default.everdict_trajectories WHERE run_id IN \(/);
    expect(deleteCall?.sql).toMatch(/HAVING min\(sealed_at\) < \{cutoff:String\}/);
  });

  it("a ClickHouse failure is remapped to UPSTREAM_ERROR (never a raw fetch error across the boundary)", async () => {
    const { fetchImpl } = fakeClickHouse(() => undefined); // 500
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);
    await expect(store.get("acme", "r1")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("ClickHouseTrajectoryStore.ensureSchema — the DDL addresses the configured database", () => {
  it("creates the database and QUALIFIES every schema statement, so reads find what boot created", async () => {
    const { calls, fetchImpl } = fakeClickHouse(() => "");
    await new ClickHouseTrajectoryStore({ url: "http://ch:8123", database: "everdict" }, fetchImpl).ensureSchema();
    expect(calls[0]?.sql).toBe("CREATE DATABASE IF NOT EXISTS everdict");
    // Unqualified DDL lands in the connection's default database while every read says `everdict.…`: boot
    // reports success and the first seal fails with UNKNOWN_TABLE.
    for (const { sql } of calls.slice(1)) expect(sql).toContain("everdict.everdict_trajectories");
    expect(calls.some(({ sql }) => sql.startsWith("CREATE TABLE IF NOT EXISTS everdict.everdict_trajectories"))).toBe(
      true,
    );
    expect(calls.filter(({ sql }) => sql.startsWith("ALTER TABLE")).length).toBeGreaterThan(0);
  });

  it("refuses a database name that is not a plain identifier — it becomes SQL text, not a bound param", async () => {
    const { fetchImpl } = fakeClickHouse(() => "");
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123", database: "ever;DROP" }, fetchImpl);
    await expect(store.ensureSchema()).rejects.toThrow(/not a plain identifier/);
  });
});
