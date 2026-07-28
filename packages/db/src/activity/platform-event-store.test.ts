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
