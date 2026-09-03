import type { ScorecardRecord } from "@everdict/contracts";
import { Pool as PgPool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SqlClient, sqlClient } from "../client.js";
import { migrate } from "../migrate.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";
import { InMemoryScorecardStore } from "./scorecard-store.js";

// ── THE PAGE AND THE COUNT, PLANNED BY A REAL ENGINE ──────────────────────────────────────────────────
//
// A fake `SqlClient` proves the statement's TEXT and nothing else: it answers happily to SQL no planner
// accepts, and it cannot tell whether `(created_at, id) < ($1::timestamptz, $2)` orders rows the way the
// `ORDER BY` beside it does — which is the entire correctness of a keyset cursor. Nor can it say whether
// `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')` buckets a row into the same day the in-memory twin
// and the web derive from the ISO string. Both of those are questions only Postgres answers.
//
// So this scenario drives the REAL store against a throwaway database and asserts the two things the unit
// test structurally cannot: the page's ordering/continuation, and that Postgres and the twin agree — row for
// row and bucket for bucket — over the same records.
const DATABASE_URL = process.env.EVERDICT_E2E_DATABASE_URL;

const at = (id: string, createdAt: string, over: Partial<ScorecardRecord> = {}): ScorecardRecord =>
  ({
    id,
    tenant: "paging-acme",
    dataset: { id: "terminal-bench", version: "1.0.0" },
    harness: { id: "claude-code", version: "1" },
    status: "succeeded",
    createdAt,
    updatedAt: createdAt,
    steps: [],
    ...over,
  }) as ScorecardRecord;

// Two instants shared by two batches each, so the id tie-break is exercised on both sides of a page
// boundary; two calendar days, one of which straddles a UTC midnight in most local timezones.
const RECORDS: ScorecardRecord[] = [
  at("b2", "2026-08-01T10:00:00.000Z", { runtime: "nomad-eu", createdBy: "dana" }),
  at("b1", "2026-08-01T10:00:00.000Z", { runtime: "local", createdBy: "sam" }),
  at("a4", "2026-08-02T23:30:00.000Z", { runtime: "nomad-eu", createdBy: "sam", status: "failed" }),
  at("a3", "2026-08-02T23:30:00.000Z", { runtime: "nomad-eu", createdBy: "dana" }),
  at("a2", "2026-08-02T09:00:00.000Z", {}),
  at("a1", "2026-08-01T00:00:00.000Z", { harness: { id: "codex-cli", version: "2" } }),
];

describe.skipIf(!DATABASE_URL)("the scorecards page over real Postgres", () => {
  if (!DATABASE_URL) return; // type narrowing (separate from skipIf)
  let pool: PgPool;
  let client: SqlClient;
  let pg: PgScorecardStore;
  const twin = new InMemoryScorecardStore();

  beforeAll(async () => {
    pool = new PgPool({ connectionString: DATABASE_URL });
    client = sqlClient(pool);
    await migrate(client);
    for (const record of RECORDS) {
      await pg_create(record);
      await twin.create(record);
    }
  }, 120_000);

  async function pg_create(record: ScorecardRecord): Promise<void> {
    pg ??= new PgScorecardStore(client);
    await pg.create(record);
  }

  afterAll(async () => {
    await client.query("DELETE FROM everdict_scorecards WHERE tenant = $1", ["paging-acme"]);
    await pool.end();
  });

  it("orders newest first with the id breaking a tie — the order the cursor is defined against", async () => {
    const rows = await pg.list("paging-acme");

    expect(rows.map((r) => r.id)).toEqual(["a4", "a3", "a2", "b2", "b1", "a1"]);
  });

  it("continues a page across an instant two batches share, without repeating or skipping", async () => {
    // The boundary is deliberately INSIDE the a4/a3 tie: a cursor that compared only the timestamp would
    // either hand back a4 again or skip a3 entirely.
    const first = await pg.list("paging-acme", { limit: 1 });
    expect(first.map((r) => r.id)).toEqual(["a4"]);

    const seen: string[] = [];
    let cursor = first[0] as ScorecardRecord;
    for (let page = 0; page < RECORDS.length; page += 1) {
      const next = await pg.list("paging-acme", {
        limit: 2,
        before: { createdAt: cursor.createdAt, id: cursor.id },
      });
      if (next.length === 0) break;
      seen.push(...next.map((r) => r.id));
      cursor = next[next.length - 1] as ScorecardRecord;
    }

    expect(seen).toEqual(["a3", "a2", "b2", "b1", "a1"]);
    expect(new Set(seen).size).toBe(seen.length); // nothing repeated
  });

  it("agrees with the in-memory twin, row for row, on every narrow the list offers", async () => {
    const narrows = [
      {},
      { status: "failed" as const },
      { runtime: "nomad-eu" },
      { createdBy: "sam" },
      { day: "2026-08-02" },
      { search: "CODEX" },
      { search: "b" },
      { harness: "claude-code" },
      { limit: 3 },
      { limit: 2, before: { createdAt: "2026-08-02T23:30:00.000Z", id: "a4" } },
      // The facet SETS, including the unset bucket — `= ANY($n::text[])` on one side, `includes` on the
      // other, and `coalesce(col, '')` is the half only Postgres can be asked about.
      { statuses: ["failed" as const, "cancelled" as const] },
      { runtimes: ["nomad-eu", "local"] },
      { runtimes: [""] },
      { creators: ["dana"] },
      { creators: [""] },
      {},
      {},
      { harnesses: ["codex-cli"] },
    ];

    for (const filter of narrows) {
      const fromPg = (await pg.list("paging-acme", filter)).map((r) => r.id);
      const fromTwin = (await twin.list("paging-acme", filter)).map((r) => r.id);
      expect({ filter, ids: fromPg }).toEqual({ filter, ids: fromTwin });
    }
  });

  it("buckets a UTC day the same way the twin does, including one that straddles a local midnight", async () => {
    // 23:30Z on the 2nd is the 3rd in Seoul. The store must answer the UTC day, because that is the key the
    // web derives from the ISO string — a header counted in one timezone over rows bucketed in another
    // disagrees with itself twice a day.
    const sorted = (rows: { key: string | null; count: number }[]) =>
      [...rows].sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""));

    expect(sorted(await pg.countByGroup("paging-acme", "day"))).toEqual(
      sorted(await twin.countByGroup("paging-acme", "day")),
    );
    expect(sorted(await pg.countByGroup("paging-acme", "day"))).toEqual([
      { key: "2026-08-01", count: 3 },
      { key: "2026-08-02", count: 3 },
    ]);
  });

  it("agrees with the twin on every grouping axis, unset bucket included", async () => {
    const sorted = (rows: { key: string | null; count: number }[]) =>
      [...rows].sort((a, b) => `${a.key}`.localeCompare(`${b.key}`));

    for (const axis of ["day", "status", "harness", "dataset", "creator"] as const) {
      expect({ axis, rows: sorted(await pg.countByGroup("paging-acme", axis)) }).toEqual({
        axis,
        rows: sorted(await twin.countByGroup("paging-acme", axis)),
      });
    }
  });

  it("counts the SET even while a page is requested", async () => {
    const counted = await pg.countByGroup("paging-acme", "day", {
      limit: 1,
      before: { createdAt: "2026-08-02T23:30:00.000Z", id: "a4" },
    });

    expect(counted.reduce((sum, row) => sum + row.count, 0)).toBe(RECORDS.length);
  });
});
