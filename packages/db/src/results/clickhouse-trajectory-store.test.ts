import { type SealedTrajectory, type TrajectoryStore, collectTrajectoryEvents } from "@everdict/application-control";
import type { TraceEvent } from "@everdict/contracts";
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

// One plane as the BODY-FREE read returns it. `seal` and `usage` both go through this shape: neither needs a
// body, and the whole point of the read is that `body` never appears in the statement.
const planeLine = (over: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    run_id: "r1",
    emitter: "otlp",
    tenant_first: "acme",
    source_first: "otlp",
    event_count_first: 2,
    owner_first: "",
    kind_first: "",
    label_first: "",
    preview_first: "",
    usage_first: "",
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
    const rows: Array<Record<string, unknown>> = [];
    const { calls, fetchImpl } = fakeClickHouse((sql, _params, body) => {
      // The BODY-FREE plane read `seal` now uses to decide "has this emitter sealed already?". It used to
      // call `get`, which aggregates `argMin(body, …)` over every plane — so appending one segment re-read
      // the entire trajectory. The two statements are told apart by this ORDER BY, and the assertion below
      // pins the property that matters: no body travels.
      if (sql.includes("GROUP BY run_id, emitter"))
        return rows
          .map((row) =>
            planeLine({ emitter: row.emitter, source_first: row.source, event_count_first: row.event_count }),
          )
          .join("");
      // The events INSERT is a multi-line JSONEachRow batch, not one plane row — parsing it as a plane is
      // how a fake starts answering questions the real store never would.
      if (sql.startsWith("INSERT INTO default.everdict_trajectories ")) {
        rows.push(JSON.parse(body) as Record<string, unknown>);
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

    // …and the read that decided all of this never asked for a body. `seal` used to answer a set membership
    // by hauling every plane's events through ClickHouse's memory and then ours, which on a long-horizon run
    // is the OOM on the WRITE side.
    const planeReads = calls.filter((c) => c.sql.includes("GROUP BY run_id, emitter"));
    expect(planeReads.length, "seal stopped reading the planes at all").toBeGreaterThan(0);
    for (const read of planeReads)
      expect(read.sql, "seal read a body to decide a set membership").not.toMatch(/\bbody\b/);
  });

  it("refuses to seal under an id another workspace owns — one read answers both questions", async () => {
    // The cross-tenant guard used to need a SECOND statement (`SELECT run_id … LIMIT 1`) because the first
    // one was tenant-scoped through `get`. The plane read is not, so rows-exist-but-header-is-theirs is
    // answerable from the same round trip — and this is the test that keeps the guard once its second
    // statement is gone.
    const { calls, fetchImpl } = fakeClickHouse((sql) => {
      if (sql.includes("GROUP BY run_id, emitter")) return planeLine({ tenant_first: "rival" });
      return "";
    });
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    const sealed = await store.seal({
      runId: "r1",
      tenant: "acme",
      source: "otlp",
      events: [{ t: 0, kind: "llm_call", model: "m" }],
    });

    expect(sealed.created, "a second workspace wrote a row under another tenant's run id").toBe(false);
    expect(
      calls.some((c) => c.sql.startsWith("INSERT")),
      "the INSERT went out anyway",
    ).toBe(false);
  });

  it("reads resolve first-write-wins per emitter and stay tenant-scoped; values travel as bound params", async () => {
    const { calls, fetchImpl } = fakeClickHouse((sql) => {
      if (sql.includes("GROUP BY run_id, emitter"))
        return (
          planeLine({ event_count_first: 2 }) +
          planeLine({
            emitter: "service:checkout",
            event_count_first: 1,
            sealed_at_first: "2026-07-30T00:00:05.000Z",
          })
        );
      // The events table: sizes first, then the bodies that survived the byte budget.
      if (sql.includes("argMin(bytes, sealed_at)"))
        return `${JSON.stringify({ seq: 1, bytes_first: 40 })}\n${JSON.stringify({ seq: 2, bytes_first: 40 })}\n`;
      if (sql.includes("argMin(body, sealed_at)"))
        return (
          `${JSON.stringify({ seq: 1, body_first: JSON.stringify({ t: 0, kind: "llm_call", model: "m" }) })}\n` +
          `${JSON.stringify({ seq: 2, body_first: JSON.stringify({ t: 1, kind: "message", role: "assistant", text: "x" }) })}\n`
        );
      return "";
    });
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    const hit = await whole(store, "acme", "r1");
    expect(hit?.meta).toMatchObject({ runId: "r1", source: "otlp", eventCount: 3 }); // every plane counted
    expect(hit?.segments.map((s) => s.emitter)).toEqual(["otlp", "service:checkout"]);
    expect(hit?.executionEmitter).toBe("otlp");
    expect(hit?.events).toHaveLength(2); // the execution plane's page, not the service's
    const planeRead = calls.find((c) => c.sql.includes("GROUP BY run_id, emitter"));
    expect(planeRead?.sql).toMatch(/ORDER BY sealed_at_first ASC/); // the read-side half of first-write-wins
    expect(planeRead?.params.get("param_runId")).toBe("r1"); // bound, never concatenated
    // THE PROPERTY THIS RUNG EXISTS FOR: resolving a trajectory ships no evidence. `argMin(body, …)` over
    // the plane table is what made a long-horizon read cost the whole trajectory twice.
    expect(planeRead?.sql, "the plane read hauled bodies again").not.toMatch(/argMin\(body,/);

    expect(await whole(store, "rival", "r1")).toBeUndefined(); // tenant check after the point read
  });

  it("an identity read ranks the ASKED attempt above the clock, and drops the planes that name another", async () => {
    // The clock read cannot answer "which attempt's evidence is this": `sealed_at` is the writer's own stamp,
    // so a backdated duplicate wins argMin and serves the abandoned attempt's bytes. The identity read orders
    // by (rank, clock) instead and refuses rank 2 — a plane belonging to a different execution.
    const { calls, fetchImpl } = fakeClickHouse((sql) =>
      sql.includes("GROUP BY run_id, emitter") ? planeLine({ attempt_id_first: "exec-LATE#g2" }) : "",
    );
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    const read = await whole(store, "acme", "r1", { attemptId: "exec-LATE#g2" });
    expect(read?.segments[0]?.attemptId).toBe("exec-LATE#g2");
    const sql = calls[0]?.sql ?? "";
    expect(sql).toMatch(/if\(attempt_id = \{attemptId:String\}, 0, if\(attempt_id = '', 1, 2\)\) AS attempt_rank/);
    // identity first, clock within it — on the columns the plane read actually carries, which no longer
    // include the body.
    expect(sql).toMatch(/argMin\(attempt_id, \(attempt_rank, sealed_at\)\) AS attempt_id_first/);
    expect(sql, "the identity read hauled bodies").not.toMatch(/argMin\(body,/);
    expect(sql).toMatch(/HAVING min\(attempt_rank\) < 2/); // another attempt's plane is dropped, never served
    expect(calls[0]?.params.get("param_attemptId")).toBe("exec-LATE#g2"); // bound, never concatenated

    // …and the clock-resolved read stays exactly what it was for callers holding no identity to ask by.
    const before = calls.length;
    await whole(store, "acme", "r1");
    const clockRead = calls.slice(before).find((c) => c.sql.includes("GROUP BY run_id, emitter"));
    expect(clockRead?.sql).toMatch(/argMin\(attempt_id, sealed_at\) AS attempt_id_first/); // clock alone
    expect(clockRead?.sql).not.toMatch(/attempt_rank/);
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
    // Two deletes now, events first (the plane rows are what `expiredRunsSql` reads, so they go last).
    const deletes = calls.filter((c) => c.sql.startsWith("DELETE"));
    expect(deletes[0]?.sql, "the event rows were left behind by retention").toMatch(
      /DELETE FROM default\.everdict_trajectory_events WHERE run_id IN \(/,
    );
    const deleteCall = deletes.find((c) => c.sql.includes("everdict_trajectories WHERE"));
    // Retention cuts by the TRAJECTORY's earliest seal — never orphaning a run's later plane.
    expect(deleteCall?.sql).toMatch(/DELETE FROM default.everdict_trajectories WHERE run_id IN \(/);
    expect(deleteCall?.sql).toMatch(/HAVING min\(sealed_at\) < \{cutoff:String\}/);
  });

  it("a ClickHouse failure is remapped to UPSTREAM_ERROR (never a raw fetch error across the boundary)", async () => {
    const { fetchImpl } = fakeClickHouse(() => undefined); // 500
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);
    await expect(whole(store, "acme", "r1")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("ClickHouseTrajectoryStore.ensureSchema — the DDL addresses the configured database", () => {
  it("creates the database and QUALIFIES every schema statement, so reads find what boot created", async () => {
    const { calls, fetchImpl } = fakeClickHouse(() => "");
    await new ClickHouseTrajectoryStore({ url: "http://ch:8123", database: "everdict" }, fetchImpl).ensureSchema();
    expect(calls[0]?.sql).toBe("CREATE DATABASE IF NOT EXISTS everdict");
    // Unqualified DDL lands in the connection's default database while every read says `everdict.…`: boot
    // reports success and the first seal fails with UNKNOWN_TABLE.
    // BOTH tables are qualified — the events table (mig 0200's rung-2 twin) is the second one that would
    // otherwise land in the connection's default database while every read says `everdict.…`.
    for (const { sql } of calls.slice(1)) expect(sql).toMatch(/everdict\.everdict_trajector(ies|y_events)/);
    expect(calls.some(({ sql }) => sql.startsWith("CREATE TABLE IF NOT EXISTS everdict.everdict_trajectories"))).toBe(
      true,
    );
    expect(
      calls.some(({ sql }) => sql.startsWith("CREATE TABLE IF NOT EXISTS everdict.everdict_trajectory_events")),
    ).toBe(true);
    expect(calls.filter(({ sql }) => sql.startsWith("ALTER TABLE")).length).toBeGreaterThan(0);
  });

  it("ALTERs every column the CREATE declares, VERBATIM — a table from an older install must serve today's reads", async () => {
    // attempt_id shipped in the CREATE and in the read queries but was left out of the ALTER list: fresh
    // installs worked while every pre-existing deployment failed each `get` with UNKNOWN_IDENTIFIER (Code 47)
    // — after a boot that reported success. Both statements now come from ONE descriptor, and this reads the
    // wire to prove it: every column line of the emitted CREATE — whatever its type, with or without a
    // DEFAULT — must appear as its own ADD COLUMN, spelled identically. A String-only check would have let a
    // `UInt32` or a `Nullable(...)` column repeat the drift under a different type.
    const { calls, fetchImpl } = fakeClickHouse(() => "");
    await new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl).ensureSchema();
    const create = calls.find(({ sql }) => sql.startsWith("CREATE TABLE"))?.sql ?? "";
    // Column lines only: INDEX/CONSTRAINT clauses have no ADD COLUMN twin and are excluded by the leading
    // keyword, not by a hand-kept list.
    const declared = [...create.matchAll(/^ {2}(?!INDEX|CONSTRAINT|PROJECTION)(\w+ .+?),?$/gm)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
    expect(declared).toContain("attempt_id String DEFAULT ''");
    expect(declared).toContain("event_count UInt32"); // a non-String, non-defaulted column is covered too
    // A floor, not a census: what is under test is that CREATE and ALTER agree, and pinning the exact count
    // would make every new column a failing test in the commit that adds it.
    expect(declared.length).toBeGreaterThanOrEqual(13);
    const alters = calls.filter(({ sql }) => sql.startsWith("ALTER TABLE")).map(({ sql }) => sql);
    for (const column of declared)
      expect(
        alters.some((sql) => sql.endsWith(`ADD COLUMN IF NOT EXISTS ${column}`)),
        `column "${column}" is created for fresh installs but never ALTERed onto existing tables`,
      ).toBe(true);
  });

  it("refuses a database name that is not a plain identifier — it becomes SQL text, not a bound param", async () => {
    const { fetchImpl } = fakeClickHouse(() => "");
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123", database: "ever;DROP" }, fetchImpl);
    await expect(store.ensureSchema()).rejects.toThrow(/not a plain identifier/);
  });
});

// A TEST convenience over fixtures of known, small size: the plane headers plus every event, assembled from
// the two production reads. Deliberately NOT a production shape — `collectTrajectoryEvents` is how a caller
// that genuinely needs the whole stream gets it, and what bounds it here is the fixture.
async function whole(
  store: TrajectoryStore,
  tenant: string,
  runId: string,
  opts?: { attemptId: string },
): Promise<(SealedTrajectory & { events: TraceEvent[] }) | undefined> {
  const planes = await store.planes(tenant, runId, opts);
  if (!planes) return undefined;
  return { ...planes, events: await collectTrajectoryEvents(store, tenant, runId, opts ?? {}) };
}
