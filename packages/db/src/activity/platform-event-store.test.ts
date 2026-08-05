import type { PlatformEventRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryPlatformEventStore, PgPlatformEventStore } from "./platform-event-store.js";

function fakeClient(handler: (text: string, params?: unknown[]) => { rows: unknown[] }): {
  client: SqlClient;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client: SqlClient = {
    async query(text, params) {
      calls.push({ text, params });
      return handler(text, params) as { rows: never[] };
    },
  };
  return { client, calls };
}

function fact(overrides: Partial<Omit<PlatformEventRecord, "seq">> = {}): Omit<PlatformEventRecord, "seq"> {
  return {
    id: "ev-1",
    tenant: "acme",
    kind: "scorecard.completed",
    subject: { type: "scorecard", id: "sc-1" },
    payload: { status: "succeeded" },
    message: "Scorecard sc-1 succeeded",
    createdAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("InMemoryPlatformEventStore", () => {
  it("assigns a monotonic seq on append and lists ascending from a cursor", async () => {
    // Given three appended facts
    const store = new InMemoryPlatformEventStore();
    const first = await store.append(fact({ id: "ev-1" }));
    await store.append(fact({ id: "ev-2", kind: "scorecard.submitted" }));
    const third = await store.append(fact({ id: "ev-3" }));
    expect(first.seq).toBe(1);
    expect(third.seq).toBe(3);

    // When listing after the first seq
    const events = await store.list("acme", { afterSeq: first.seq });

    // Then only the later facts return, in seq order
    expect(events.map((e) => e.id)).toEqual(["ev-2", "ev-3"]);
  });

  it("filters by kind and scopes to the tenant", async () => {
    const store = new InMemoryPlatformEventStore();
    await store.append(fact({ id: "ev-1", kind: "scorecard.submitted" }));
    await store.append(fact({ id: "ev-2", kind: "scorecard.completed" }));
    await store.append(fact({ id: "ev-other", tenant: "other" }));

    const completed = await store.list("acme", { kinds: ["scorecard.completed"] });
    expect(completed.map((e) => e.id)).toEqual(["ev-2"]);
    expect(await store.get("acme", "ev-other")).toBeUndefined();
    expect((await store.get("acme", "ev-1"))?.kind).toBe("scorecard.submitted");
  });
});

describe("PgPlatformEventStore", () => {
  it("appends with parameterized SQL and returns the store-assigned seq", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ seq: "7" }] }));
    const store = new PgPlatformEventStore(client);

    const appended = await store.append(fact({ actor: "user-1", causedBy: "run-9" }));

    expect(appended.seq).toBe(7);
    expect(calls[0]?.text).toContain("INSERT INTO everdict_platform_events");
    expect(calls[0]?.text).toContain("RETURNING seq");
    expect(calls[0]?.params).toEqual([
      "ev-1",
      "acme",
      "scorecard.completed",
      "scorecard",
      "sc-1",
      "user-1",
      JSON.stringify({ status: "succeeded" }),
      "run-9",
      "Scorecard sc-1 succeeded",
      "2026-07-28T00:00:00.000Z",
    ]);
  });

  it("lists ascending by seq with cursor + kind filters and maps rows back to records", async () => {
    const row = {
      seq: 3,
      id: "ev-3",
      tenant: "acme",
      kind: "scorecard.completed",
      subject_type: "scorecard",
      subject_id: "sc-1",
      actor: null,
      payload: { status: "succeeded" },
      caused_by: null,
      message: "Scorecard sc-1 succeeded",
      created_at: "2026-07-28T00:00:00.000Z",
    };
    const { client, calls } = fakeClient(() => ({ rows: [row] }));
    const store = new PgPlatformEventStore(client);

    const events = await store.list("acme", { afterSeq: 2, kinds: ["scorecard.completed"], limit: 10 });

    expect(calls[0]?.text).toContain("seq > $2");
    expect(calls[0]?.text).toContain("kind = ANY($3)");
    expect(calls[0]?.text).toContain("ORDER BY seq ASC");
    expect(calls[0]?.params).toEqual(["acme", 2, ["scorecard.completed"], 10]);
    expect(events[0]).toMatchObject({ id: "ev-3", seq: 3, subject: { type: "scorecard", id: "sc-1" } });
  });
});

describe("dailyCounts — the log counted, for the workspace pulse's trend", () => {
  it("in-memory: buckets per (day × kind × outcome), scoped to the tenant and the half-open window", async () => {
    // Given facts across three days, one of them another tenant's
    const store = new InMemoryPlatformEventStore();
    await store.append(fact({ id: "a", kind: "issue.created", payload: {}, createdAt: "2026-08-01T01:00:00.000Z" }));
    await store.append(fact({ id: "b", kind: "issue.created", payload: {}, createdAt: "2026-08-01T23:00:00.000Z" }));
    await store.append(
      fact({ id: "c", kind: "issue.status_changed", payload: { to: "done" }, createdAt: "2026-08-01T12:00:00.000Z" }),
    );
    await store.append(
      fact({
        id: "d",
        kind: "issue.status_changed",
        payload: { to: "in_progress" },
        createdAt: "2026-08-01T13:00:00.000Z",
      }),
    );
    await store.append(fact({ id: "e", kind: "issue.created", payload: {}, createdAt: "2026-08-02T00:00:00.000Z" }));
    await store.append(
      fact({ id: "other", tenant: "other", kind: "issue.created", payload: {}, createdAt: "2026-08-01T05:00:00.000Z" }),
    );

    // When counting the first day only (`to` is exclusive)
    const counts = await store.dailyCounts("acme", {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });

    // Then the two creations collapse into one bucket, the transitions split by destination, and nothing from
    // the next day or the other tenant appears
    expect(counts).toEqual([
      { day: "2026-08-01", kind: "issue.created", count: 2 },
      { day: "2026-08-01", kind: "issue.status_changed", outcome: "done", count: 1 },
      { day: "2026-08-01", kind: "issue.status_changed", outcome: "in_progress", count: 1 },
    ]);
  });

  it("in-memory: a payload whose `to` is not a string has no outcome, exactly as SQL's ->> would report", async () => {
    const store = new InMemoryPlatformEventStore();
    await store.append(fact({ id: "a", kind: "run.completed", payload: { to: { id: 1 } } }));
    const counts = await store.dailyCounts("acme", {
      from: "2026-07-28T00:00:00.000Z",
      to: "2026-07-29T00:00:00.000Z",
    });
    expect(counts).toEqual([{ day: "2026-07-28", kind: "run.completed", count: 1 }]);
  });

  it("pg: one grouped query cutting the day in UTC, with the window as parameters", async () => {
    const { client, calls } = fakeClient(() => ({
      rows: [
        { day: "2026-08-01", kind: "issue.created", outcome: null, count: "2" },
        { day: "2026-08-01", kind: "issue.status_changed", outcome: "done", count: 1 },
      ],
    }));
    const store = new PgPlatformEventStore(client);

    const counts = await store.dailyCounts("acme", {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    });

    expect(calls[0]?.text).toContain("AT TIME ZONE 'UTC'");
    expect(calls[0]?.text).toContain("payload->>'to' AS outcome");
    expect(calls[0]?.text).toContain("created_at >= $2 AND created_at < $3");
    expect(calls[0]?.text).toContain("GROUP BY 1, 2, 3");
    expect(calls[0]?.params).toEqual(["acme", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"]);
    // count comes back as a string from pg's bigint; a NULL outcome drops the key rather than becoming "null"
    expect(counts).toEqual([
      { day: "2026-08-01", kind: "issue.created", count: 2 },
      { day: "2026-08-01", kind: "issue.status_changed", outcome: "done", count: 1 },
    ]);
  });
});

describe("deleteOlderThan — EO4 retention (the log is a buffer, the TTL is the operator's replay window)", () => {
  it("in-memory: prunes strictly-older facts and reports the count; newer facts and seq continuity survive", async () => {
    const store = new InMemoryPlatformEventStore();
    for (const [id, createdAt] of [
      ["ev-old", "2026-07-01T00:00:00.000Z"],
      ["ev-edge", "2026-07-15T00:00:00.000Z"],
      ["ev-new", "2026-07-29T00:00:00.000Z"],
    ] as const) {
      await store.append({
        id,
        tenant: "acme",
        kind: "run.completed",
        subject: { type: "run", id },
        payload: {},
        message: "m",
        createdAt,
      });
    }
    expect(await store.deleteOlderThan("2026-07-15T00:00:00.000Z")).toBe(1); // cutoff itself survives (>=)
    const left = await store.listAll({ order: "asc" });
    expect(left.map((e) => e.id)).toEqual(["ev-edge", "ev-new"]);
    expect(left.map((e) => e.seq)).toEqual([2, 3]); // seq is history, never renumbered by a prune
  });

  it("pg: one bounded DELETE with the cutoff as a parameter, count from RETURNING", async () => {
    const { client, calls } = fakeClient(() => ({ rows: [{ id: "ev-old" }, { id: "ev-old2" }] }));
    const store = new PgPlatformEventStore(client);
    expect(await store.deleteOlderThan("2026-07-15T00:00:00.000Z")).toBe(2);
    expect(calls[0]?.text).toContain("DELETE FROM everdict_platform_events WHERE created_at < $1");
    expect(calls[0]?.params).toEqual(["2026-07-15T00:00:00.000Z"]);
  });
});
