import type { TraceEvent } from "@everdict/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../client.js";
import { ClickHouseTrajectoryStore } from "./clickhouse-trajectory-store.js";
import { InMemoryTrajectoryStore, PgTrajectoryStore } from "./trajectory-store.js";

// ── THE INGESTION METER COUNTS WHAT ARRIVED IN THE WINDOW (perf review) ─────────────────────────────
//
// `ingestedSince` is the OTLP door's admission meter — it runs once per exporter push — and it asked its
// question the wrong way round on all three impls: it dated a whole trajectory by its HEADER's seal stamp,
// then attributed every plane the run had ever gathered to that one moment. Two consequences, and the second
// is what made the API slow rather than merely wrong:
//
//   · WRONG ANSWER — a service pushing spans into a run first sealed two hours ago metered as zero, and a
//     run whose header sealed inside the window metered every segment it had ever collected as this hour's.
//   · UNBOUNDED READ — on ClickHouse the time filter sat OUTSIDE two GROUP BYs, so the engine could not use
//     it to prune granules on a table keyed `(tenant, sealed_at, run_id)`. Admitting one push read every row
//     the workspace had ever sealed, which is why the door got slower as evidence accumulated.
//
// The rule, one owner, three impls: A PLANE IS COUNTED BY ITS OWN SEAL STAMP, and `trajectories` is the
// number of runs TOUCHED in the window.
//
// SEEN RED against the pre-fix code (4 of the 6 below), observed text:
//   · `expected +0 to be 2` — the late plane metered as NOTHING, because its run's header predated the
//     window and the header's stamp was the only one consulted
//   · `expected 'SELECT count(*) AS trajectories, COAL…' to contain 'everdict_trajectory_segments'`
//   · `expected 'SELECT count() AS trajectories, sum(e…' to contain
//     'tenant = {tenant:String} AND sealed_a…'` — the window was outside the aggregate
//   · `expected 0 to be greater than 0` — no `max_execution_time` on the statement at all

const EVENTS = (n: number): TraceEvent[] =>
  Array.from({ length: n }, (_, i) => ({ t: i, kind: "message", role: "assistant", text: `e${i}` }) as const);

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

function fakeClickHouse(reply: string): {
  calls: string[];
  fetchImpl: typeof fetch;
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: URL | string | Request) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    calls.push(url.searchParams.get("query") ?? "");
    return new Response(reply, { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("ingestedSince — a plane is metered by its own seal stamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts a LATE plane on an OLD run, and only that plane's events", async () => {
    // Given: a run whose first plane sealed well before the window
    const store = new InMemoryTrajectoryStore();
    vi.setSystemTime(new Date("2026-09-03T10:00:00.000Z"));
    await store.seal({ runId: "r1", tenant: "acme", source: "run", emitter: "run", events: EVENTS(3) });

    // When: a service pushes its own plane into that same run INSIDE the window
    vi.setSystemTime(new Date("2026-09-03T12:30:00.000Z"));
    await store.seal({ runId: "r1", tenant: "acme", source: "otlp", emitter: "service:api", events: EVENTS(2) });

    // Then: the window meters the 2 events that arrived in it — not 0 (the run is "old"), and not 5
    // (the run is "new"). The run is counted once, as touched.
    const used = await store.ingestedSince("acme", "2026-09-03T12:00:00.000Z");
    expect(used.events).toBe(2);
    expect(used.trajectories).toBe(1);
  });

  it("meters nothing for a run whose every plane predates the window", async () => {
    // Given: a run sealed entirely before the window
    const store = new InMemoryTrajectoryStore();
    vi.setSystemTime(new Date("2026-09-03T10:00:00.000Z"));
    await store.seal({ runId: "r1", tenant: "acme", source: "run", emitter: "run", events: EVENTS(4) });

    // Then: nothing arrived in the window
    const used = await store.ingestedSince("acme", "2026-09-03T12:00:00.000Z");
    expect(used).toEqual({ trajectories: 0, events: 0 });
  });

  it("never meters another workspace's ingestion", async () => {
    // Given: two workspaces sealing inside the same window
    const store = new InMemoryTrajectoryStore();
    vi.setSystemTime(new Date("2026-09-03T12:30:00.000Z"));
    await store.seal({ runId: "r1", tenant: "acme", source: "run", emitter: "run", events: EVENTS(3) });
    await store.seal({ runId: "r2", tenant: "globex", source: "run", emitter: "run", events: EVENTS(7) });

    // Then: each workspace's meter is its own
    expect(await store.ingestedSince("acme", "2026-09-03T12:00:00.000Z")).toEqual({ trajectories: 1, events: 3 });
    expect(await store.ingestedSince("globex", "2026-09-03T12:00:00.000Z")).toEqual({ trajectories: 1, events: 7 });
  });

  it("Postgres reads BOTH plane tables by each one's own stamp", async () => {
    // Given: the Pg adapter
    const { client, calls } = fakeClient(() => ({ rows: [{ trajectories: 1, events: 2 }] }));
    const store = new PgTrajectoryStore(client);

    // When: the meter is read
    const used = await store.ingestedSince("acme", "2026-09-03T12:00:00.000Z");

    // Then: the segments table is in the statement — a plane there is ingestion too — and the window
    // predicate applies to each table's OWN sealed_at rather than to the header's alone.
    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("everdict_trajectory_segments");
    expect(sql.match(/sealed_at > \$2::timestamptz/g)).toHaveLength(2);
    // …and the denormalized roll-up is NOT added on top of the rows it summarizes.
    expect(sql).not.toContain("segment_event_count");
    expect(used).toEqual({ trajectories: 1, events: 2 });
  });

  it("ClickHouse filters the window as a ROW predicate, so the primary key can prune it", async () => {
    // Given: the ops-scale adapter
    const { calls, fetchImpl } = fakeClickHouse(`${JSON.stringify({ trajectories: 1, events: 2 })}\n`);
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    // When: the meter is read
    const used = await store.ingestedSince("acme", "2026-09-03T12:00:00.000Z");

    // Then: `sealed_at` is compared in the innermost WHERE, beside the tenant — the table is
    // ORDER BY (tenant, sealed_at, run_id), and a predicate behind a GROUP BY prunes nothing.
    const sql = calls[0] ?? "";
    expect(sql).toContain("tenant = {tenant:String} AND sealed_at > {since:String}");
    // …and never as a filter over the aggregate, which is the shape that read the whole history.
    expect(sql).not.toContain("sealed_at_run >");
    expect(used).toEqual({ trajectories: 1, events: 2 });
  });

  it("ClickHouse gives every statement a server-side deadline and a result ceiling", async () => {
    // Given: an adapter with no explicit tuning
    const calls: URL[] = [];
    const fetchImpl = (async (input: URL | string | Request) => {
      calls.push(input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url));
      return new Response(`${JSON.stringify({ trajectories: 0, events: 0 })}\n`, { status: 200 });
    }) as typeof fetch;
    const store = new ClickHouseTrajectoryStore({ url: "http://ch:8123" }, fetchImpl);

    // When: any statement is issued
    await store.ingestedSince("acme", "2026-09-03T12:00:00.000Z");

    // Then: the engine is told when to give up, so a slow query cannot hold an API request open forever
    const params = calls[0]?.searchParams;
    expect(Number(params?.get("max_execution_time"))).toBeGreaterThan(0);
    expect(Number(params?.get("max_result_bytes"))).toBeGreaterThan(0);
    expect(Number(params?.get("max_memory_usage"))).toBeGreaterThan(0);
    // …and never `break`, which would serve a truncated answer as a complete one.
    expect(params?.get("result_overflow_mode")).toBeNull();
  });
});
