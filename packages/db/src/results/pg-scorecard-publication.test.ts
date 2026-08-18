import type { PublicationPlan } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";

// ── THE PUBLICATION PLAN RIDES THE TERMINAL WRITE, AND THE DRAIN IS FENCED (mig 0187) ────────────────
//
// The plan says what a committed settlement owes outward (the mutable analysis alias, the trace-sink export).
// It is only worth anything if it commits with the settlement rather than after it, and if the drain that
// consumes it is a compare-and-swap rather than a read-then-write. Both are properties of the SQL, so both
// are pinned on the SQL — the same posture as the cancellation-operation upsert next door.

function capture(): { statements: Array<{ sql: string; params: unknown[] }>; client: SqlClient } {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client: SqlClient = {
    async query<T>(sql: string, params?: unknown[]) {
      statements.push({ sql, params: params ?? [] });
      return { rows: [] as T[] };
    },
  } as unknown as SqlClient;
  return { statements, client };
}

// The owed EXPORT — the plan's only effect since the write-only alias promotion was deleted (arch-review 55,
// Wave 7). What this file pins is the column, not the effect kind, so the fixture just has to be a real plan.
const plan: PublicationPlan = {
  state: "pending",
  plannedAt: "2026-08-15T00:00:01.000Z",
  exports: [{ idempotencyKey: "sc-1:initial-abc", payloadDigest: "sha256:x" }],
};

describe("the publication plan on the scorecard row", () => {
  it("the terminal patch carries the plan in the SAME update — one statement, one column", async () => {
    const { statements, client } = capture();
    await new PgScorecardStore(client).update("sc-1", { status: "succeeded", publication: plan }, undefined, {
      expectNonTerminal: true,
    });
    expect(statements).toHaveLength(1);
    const stmt = statements[0];
    expect(stmt?.sql ?? "").toContain("publication = $");
    // …and the value is the plan itself, so a settlement cannot commit while what it owes is written elsewhere.
    expect(stmt?.params ?? []).toContain(JSON.stringify(plan));
  });

  it("the drain's write is fenced on the plan still being pending — two publishers, one receipt", async () => {
    const { statements, client } = capture();
    await new PgScorecardStore(client).update("sc-1", { publication: { ...plan, state: "published" } }, undefined, {
      expectPublicationState: "pending",
    });
    const sql = statements[0]?.sql ?? "";
    expect(sql).toContain("publication->>'state' = $");
    expect(statements[0]?.params ?? []).toContain("pending");
  });

  it("the reconciler's sweep reads the owed settlements only, and the list projection carries the plan", async () => {
    const { statements, client } = capture();
    await new PgScorecardStore(client).list(undefined, { publicationPending: true });
    const sql = statements[0]?.sql ?? "";
    // Matches the partial index from mig 0187 exactly — the sweep reads owed rows, never the whole table.
    expect(sql).toContain("publication->>'state' = 'pending'");
    // …and the column rides the LIST projection: a plan the sweep cannot see is a settlement nobody converges.
    expect(sql).toContain(" publication,");
  });
});
