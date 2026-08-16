import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";

// ── THE ABORT SETTLE OWNS ITS TEARDOWN IN THE SAME STATEMENT (arch-review 51 P0) ─────────────────────
//
// The cancellation-operation row used to be requested AFTER the terminal settle, best-effort — a crash
// between the two left a decided abort whose teardown had no durable owner (the reconciler sweeps operation
// rows, not scorecards). Pinned on the SQL text: with `requestCancellation`, the settle statement itself
// upserts the operation row, gated on the update having matched (WHERE EXISTS on the updating CTE), so a
// refused settle owes nothing and a committed one cannot commit unowed.

function capture() {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    async query<T>(sql: string, params?: unknown[]) {
      statements.push({ sql, params: params ?? [] });
      return { rows: [] as T[] };
    },
  } as unknown as SqlClient;
  return { statements, client };
}

describe("requestCancellation — the operation upsert rides the settle statement", () => {
  it("the terminal update and the operation upsert are ONE statement, upsert gated on the matched update", async () => {
    const { statements, client } = capture();
    await new PgScorecardStore(client).update("sc-1", { status: "cancelled" }, undefined, {
      expectNonTerminal: true,
      requestCancellation: true,
    });
    expect(statements).toHaveLength(1);
    const sql = statements[0]?.sql ?? "";
    expect(sql).toContain("INSERT INTO everdict_cancellation_operations");
    expect(sql).toContain("'requested'");
    expect(sql).toContain("WHERE EXISTS (SELECT 1 FROM upd)");
    expect(sql).toContain("ON CONFLICT (scorecard_id) DO UPDATE");
  });

  it("…and composes with the outbox events in the same single statement", async () => {
    const { statements, client } = capture();
    await new PgScorecardStore(client).update(
      "sc-1",
      { status: "superseded" },
      [
        {
          id: "ev-1",
          tenant: "acme",
          kind: "scorecard.superseded",
          subject: { type: "scorecard", id: "sc-1" },
          message: "superseded",
          createdAt: "2026-08-16T00:00:00.000Z",
        } as never,
      ],
      { expectNonTerminal: true, requestCancellation: true },
    );
    expect(statements).toHaveLength(1);
    const sql = statements[0]?.sql ?? "";
    expect(sql).toContain("INSERT INTO everdict_platform_events");
    expect(sql).toContain("INSERT INTO everdict_cancellation_operations");
  });

  it("without the flag the settle statement stays exactly what it was — no operation write", async () => {
    const { statements, client } = capture();
    await new PgScorecardStore(client).update("sc-1", { status: "cancelled" }, undefined, {
      expectNonTerminal: true,
    });
    expect(statements[0]?.sql ?? "").not.toContain("everdict_cancellation_operations");
  });
});
