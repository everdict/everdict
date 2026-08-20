import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";

// ── A GUARD MUST NAME A COLUMN THAT EXISTS (arch-review 58 P1-high) ──────────────────────────────────
//
// `ScorecardRecord.export` is stored in the `sink_export` column — the row interface, the insert list and
// every patch say so, and migration 0048 spells out that the record field is `export` while the column is
// not. The monotonic projection guard added in arch-review 56 read
//
//     COALESCE((export->>'scoringRevision')::int, 0) < $n
//
// which names no column of `everdict_scorecards`. Against real PostgreSQL that update raises
// `column "export" does not exist`, so the ONE write the guard exists to make safe is the write that fails:
// the current projection never advances, and the reader-facing receipt stays behind whatever the last
// unguarded write left.
//
// The historical publication protocol is fine — this is the projection a UI reads. A settlement can be
// perfectly recorded and still be invisible.
//
// It survived because the in-memory twin has no columns to be wrong about and the fake `SqlClient` in the
// tests beside this one never compared the SQL to the schema. So this file does: the assertion is about the
// TEXT, because that is where the mistake lives, and a fake that answers any query cannot notice it.
//
// RED as of 26147830, observed:
//   expected '… COALESCE((export->>'scoringRevision')…' to contain 'sink_export->>'
//
// The general rule this pins: a guard clause is SQL, and SQL that names a column the table does not have is
// not a weaker guard, it is a failed statement.

function fakeClient(): { client: SqlClient; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    client: {
      async query(text: string) {
        sql.push(text);
        return { rows: [] as never[] };
      },
    },
  };
}

// The columns `everdict_scorecards` actually has for this record field. Named here so the assertion is about
// the schema rather than about a string somebody liked.
const EXPORT_COLUMN = "sink_export";

describe("[R58 COUNTEREXAMPLE] the export-revision guard names the column the table has", () => {
  it("guards on sink_export, not on a column named after the TypeScript field", async () => {
    const { client, sql } = fakeClient();
    await new PgScorecardStore(client)
      .update("sc-1", { status: "succeeded" }, undefined, { expectExportRevisionBelow: 3 })
      .catch(() => undefined);

    const guarded = sql.find((t) => t.includes("scoringRevision")) ?? "";
    expect(guarded, "no statement carried the export-revision guard at all").not.toBe("");
    expect(guarded, `the guard names a column the table does not have:\n${guarded}`).toContain(
      `${EXPORT_COLUMN}->>'scoringRevision'`,
    );
  });

  it("still compares as a number, so a missing revision is older than every revision", async () => {
    // A stored receipt with no revision is a pre-Wave-F one — older than everything, not unknown. `COALESCE`
    // is what says so, and dropping it would make the guard silently skip those rows.
    const { client, sql } = fakeClient();
    await new PgScorecardStore(client)
      .update("sc-1", { status: "succeeded" }, undefined, { expectExportRevisionBelow: 3 })
      .catch(() => undefined);
    const guarded = sql.find((t) => t.includes("scoringRevision")) ?? "";
    expect(guarded).toMatch(/COALESCE\(\(sink_export->>'scoringRevision'\)::int, 0\)\s*</);
  });

  it("does not add the clause when no revision bound was asked for", async () => {
    const { client, sql } = fakeClient();
    await new PgScorecardStore(client).update("sc-1", { status: "succeeded" }).catch(() => undefined);
    expect(sql.some((t) => t.includes("scoringRevision"))).toBe(false);
  });
});
