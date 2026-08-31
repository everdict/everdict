import type { ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";
import { InMemoryScorecardStore } from "./scorecard-store.js";

// ── THE LIST IS BOUNDED, AND THE COUNT IS THE SET (the read half of the scorecards-list rework) ───────
//
// A scorecard is an EVENT a CI run files, so the collection only grows and a screen that reads all of it
// pays for the whole history on every navigation. Two capabilities close that, and both are store-level
// because neither can be done by a caller holding a page: a keyset page, and a count over the SET.
//
// What these pin, and why each would otherwise regress silently:
//  · the ORDER, because a keyset cursor is defined against it and the in-memory twin used to have none;
//  · the CURSOR being a row value, because an offset drifts by one for every batch submitted while paging;
//  · the count IGNORING the page fields, because a count narrowed by the cursor reports the page size back;
//  · the twin and Postgres agreeing on the narrows, because only one of them runs in a unit test.

const at = (id: string, createdAt: string, over: Partial<ScorecardRecord> = {}): ScorecardRecord =>
  ({
    id,
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    createdAt,
    updatedAt: createdAt,
    ...over,
  }) as ScorecardRecord;

async function seeded(records: ScorecardRecord[]): Promise<InMemoryScorecardStore> {
  const store = new InMemoryScorecardStore();
  for (const record of records) await store.create(record);
  return store;
}

// Deliberately created out of order — a store that answered insertion order would pass every ordering
// assertion below by accident.
const DAY_1 = [at("b", "2026-08-01T10:00:00.000Z"), at("a", "2026-08-01T10:00:00.000Z")];
const DAY_2 = [at("c", "2026-08-02T09:00:00.000Z"), at("d", "2026-08-02T11:00:00.000Z")];

describe("scorecard list — a bounded page in a total order", () => {
  it("answers newest first, breaking a tie by id so the ordering is TOTAL", async () => {
    const store = await seeded([...DAY_1, ...DAY_2]);

    // Same instant for a and b: the id decides, descending, or a keyset cursor would repeat or skip a row
    // at every page boundary where two batches share a timestamp.
    expect((await store.list("acme")).map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("takes a page, and the cursor continues it without repeating or skipping", async () => {
    const store = await seeded([...DAY_1, ...DAY_2]);

    const first = await store.list("acme", { limit: 2 });
    expect(first.map((r) => r.id)).toEqual(["d", "c"]);
    const last = first[1] as ScorecardRecord;
    const next = await store.list("acme", {
      limit: 2,
      before: { createdAt: last.createdAt, id: last.id },
    });
    expect(next.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("keeps the tie-broken row on the right side of the cursor", async () => {
    const store = await seeded([...DAY_1, ...DAY_2]);

    // "b" and "a" share an instant. A cursor at "b" must yield "a" — not "b" again, and not nothing.
    const after = await store.list("acme", { before: { createdAt: "2026-08-01T10:00:00.000Z", id: "b" } });
    expect(after.map((r) => r.id)).toEqual(["a"]);
  });

  it("narrows by the list's own axes", async () => {
    const store = await seeded([
      at("r1", "2026-08-02T09:00:00.000Z", { runtime: "nomad-eu", createdBy: "dana" }),
      at("r2", "2026-08-02T10:00:00.000Z", { runtime: "local", createdBy: "sam" }),
      at("r3", "2026-08-01T10:00:00.000Z", { runtime: "nomad-eu", createdBy: "sam" }),
    ]);

    expect((await store.list("acme", { runtime: "nomad-eu" })).map((r) => r.id)).toEqual(["r1", "r3"]);
    expect((await store.list("acme", { createdBy: "sam" })).map((r) => r.id)).toEqual(["r2", "r3"]);
    // The day is the stored instant's UTC date — the same key the list's day grouping uses.
    expect((await store.list("acme", { day: "2026-08-02" })).map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("searches the batch id and the two capability ids it names, case-insensitively", async () => {
    const store = await seeded([
      at("aaa", "2026-08-02T09:00:00.000Z", { harness: { id: "Claude-Code", version: "1" } }),
      at("bbb", "2026-08-02T10:00:00.000Z", { dataset: { id: "terminal-bench", version: "1" } }),
    ]);

    expect((await store.list("acme", { search: "claude" })).map((r) => r.id)).toEqual(["aaa"]);
    expect((await store.list("acme", { search: "BENCH" })).map((r) => r.id)).toEqual(["bbb"]);
    expect((await store.list("acme", { search: "aa" })).map((r) => r.id)).toEqual(["aaa"]);
  });

  it("still answers EVERYTHING when no page is asked for — every internal reader depends on that", async () => {
    const store = await seeded([...DAY_1, ...DAY_2]);

    expect(await store.list("acme")).toHaveLength(4);
  });
});

describe("scorecard counts — the number a page cannot know", () => {
  it("counts the SET, not the page", async () => {
    const store = await seeded([...DAY_1, ...DAY_2]);

    // The paging fields are passed and deliberately ignored: a count narrowed by the cursor would hand back
    // the page size the caller already has.
    const counts = await store.countByGroup("acme", "day", {
      limit: 1,
      before: { createdAt: "2026-08-02T11:00:00.000Z", id: "d" },
    });

    expect(counts.sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""))).toEqual([
      { key: "2026-08-01", count: 2 },
      { key: "2026-08-02", count: 2 },
    ]);
  });

  it("counts under the SAME narrows the list takes", async () => {
    const store = await seeded([
      at("r1", "2026-08-02T09:00:00.000Z", { status: "failed" }),
      at("r2", "2026-08-02T10:00:00.000Z", { status: "succeeded" }),
      at("r3", "2026-08-01T10:00:00.000Z", { status: "failed" }),
    ]);

    expect(await store.countByGroup("acme", "day", { status: "failed" })).toEqual(
      expect.arrayContaining([
        { key: "2026-08-02", count: 1 },
        { key: "2026-08-01", count: 1 },
      ]),
    );
  });

  it("puts a batch with no owner in the unset bucket rather than inventing one", async () => {
    const store = await seeded([
      at("r1", "2026-08-02T09:00:00.000Z", { teamId: "eng" }),
      at("r2", "2026-08-02T10:00:00.000Z"),
    ]);

    expect(await store.countByGroup("acme", "team")).toEqual(
      expect.arrayContaining([
        { key: "eng", count: 1 },
        { key: null, count: 1 },
      ]),
    );
  });

  it("answers another workspace nothing — the ceiling every read stays under", async () => {
    const store = await seeded([
      at("mine", "2026-08-02T09:00:00.000Z"),
      at("theirs", "2026-08-02T10:00:00.000Z", { tenant: "other" }),
    ]);

    expect(await store.countByGroup("acme", "day")).toEqual([{ key: "2026-08-02", count: 1 }]);
    expect((await store.list("acme")).map((r) => r.id)).toEqual(["mine"]);
  });
});

// The adapter half. These assert the SQL a real engine is asked to plan — the statements themselves are
// certified against real Postgres by the trust suite; what is pinned here is that the page and the count are
// built from ONE predicate, so a facet added to the list cannot silently miss the count under it.
function recording(): { client: SqlClient; statements: Array<{ sql: string; params: unknown[] }> } {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query<T>(sql: string, params?: unknown[]) {
      statements.push({ sql, params: params ?? [] });
      return { rows: [] as T[] };
    },
  } as unknown as SqlClient;
  return { client, statements };
}

describe("scorecard list — the Postgres statements", () => {
  it("pages by ROW VALUE against its own ordering, never by offset", async () => {
    const { client, statements } = recording();

    await new PgScorecardStore(client).list("acme", {
      limit: 50,
      before: { createdAt: "2026-08-02T11:00:00.000Z", id: "d" },
    });

    const { sql, params } = statements[0] ?? { sql: "", params: [] };
    expect(sql).toContain("(created_at, id) < (");
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(sql).toContain("LIMIT");
    expect(sql).not.toContain("OFFSET");
    expect(params).toContain("2026-08-02T11:00:00.000Z");
    expect(params).toContain(50);
  });

  it("reads a day as a half-open UTC range, so the tenant/created index still serves it", async () => {
    const { client, statements } = recording();

    await new PgScorecardStore(client).list("acme", { day: "2026-08-02" });

    const { sql, params } = statements[0] ?? { sql: "", params: [] };
    expect(sql).toContain("created_at >=");
    expect(sql).toContain("interval '1 day'");
    // Not a cast on the column — `(created_at)::date = …` cannot use everdict_scorecards_tenant_created_idx.
    expect(sql).not.toContain("created_at)::date");
    expect(params).toContain("2026-08-02T00:00:00Z");
  });

  it("searches without LIKE, so a typed % finds a percent sign", async () => {
    const { client, statements } = recording();

    await new PgScorecardStore(client).list("acme", { search: "50%" });

    const { sql, params } = statements[0] ?? { sql: "", params: [] };
    expect(sql).toContain("strpos(lower(id)");
    expect(sql).not.toContain("ILIKE");
    expect(params).toContain("50%");
  });

  it("counts with the same WHERE the page uses, and without the page's own bounds", async () => {
    const { client, statements } = recording();
    const store = new PgScorecardStore(client);

    await store.list("acme", { status: "failed", limit: 10 });
    await store.countByGroup("acme", "day", { status: "failed", limit: 10 });

    const page = statements[0]?.sql ?? "";
    const counts = statements[1]?.sql ?? "";
    expect(counts).toContain("GROUP BY 1");
    expect(counts).toContain("to_char(created_at AT TIME ZONE 'UTC'");
    expect(counts).not.toContain("LIMIT");
    // One predicate, two statements: the narrow the page applied is the narrow the count applied.
    const whereOf = (sql: string) => sql.slice(sql.indexOf("WHERE"), sql.indexOf("\n", sql.indexOf("WHERE")));
    expect(whereOf(counts)).toBe(whereOf(page));
  });
});
