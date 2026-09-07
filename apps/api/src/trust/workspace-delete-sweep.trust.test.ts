import { PgWorkspaceStore, type SqlClient } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-194.
//
// DELETING A WORKSPACE REMOVES THE WORKSPACE'S DATA, AND THE SCHEMA IS WHAT SAYS WHAT THAT IS.
//
// `PgWorkspaceStore.delete()` swept a hand-maintained list of 18 `[table, column]` pairs. The migrations
// create 86 live tables and 55 of them carry a `workspace` or `tenant` column the list never named. Worse,
// `everdict_connections` was dropped in `0046_drop_connections.sql` and stayed in the list THIRD FROM THE
// TOP, so on any database migrated past 0046 the third statement raises `relation … does not exist` and the
// whole delete rejects: `DELETE /workspace` — a door the web calls from a settings page — answers 500, the
// workspace row survives, and the two tables above the dead entry have already lost their rows.
//
// ⚠️ WHY A FAKE CANNOT PROVE THIS, which is the whole reason the scenario is here. The subject IS the schema.
// A fake `SqlClient` that asserts on SQL text answers happily to a `DELETE` against a table no engine has,
// and it has no `information_schema` to derive a table set from — so the in-memory twin, which models only
// the membership graph, could not see either half. The defect lived for 166 migrations under a suite that was
// green, and the only test that existed drove `InMemoryWorkspaceStore`.
//
// Certified against a real Postgres migrated to head: the delete resolves, the workspace's rows are gone from
// tables the old list never named, and another workspace's rows in those same tables are untouched.
//
// Observed against the pre-fix store on this database (219 migrations applied):
//   delete(): THREW — relation "everdict_connections" does not exist
//     everdict_workspaces: 1 row(s) left · everdict_workspace_members: 2 · everdict_agents: 1
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust("TRUST-194 — a workspace delete removes what the schema says the workspace owns", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => {
    await pg?.close();
  });

  it("sweeps tables the old hand-maintained list never named, and leaves another workspace alone", async () => {
    const store = new PgWorkspaceStore(pg.client);
    const doomed = trustId("ws-doomed");
    const neighbour = trustId("ws-neighbour");
    await store.create({ id: doomed, name: "Doomed", owner: trustId("alice") });
    await store.ensureMembership(doomed, trustId("bob"), "member");
    await store.create({ id: neighbour, name: "Neighbour", owner: trustId("carol") });

    // `everdict_agents` is one of the 55 the old list never named, and it is a plain tenant-scoped table —
    // no cascade reaches it, so it is only ever removed by the sweep naming it.
    for (const tenant of [doomed, neighbour]) {
      await pg.client.query(
        "INSERT INTO everdict_agents (tenant, id, version, spec) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        [tenant, "agent-1", "1", "{}"],
      );
    }

    // The pre-fix store REJECTED here. That is the first assertion, and it is not a formality: an operator
    // reading a 500 has no reason to think anything at all was deleted.
    await expect(store.delete(doomed), "the workspace delete did not complete").resolves.toBeUndefined();

    const count = async (table: string, column: string, value: string): Promise<number> => {
      const res = await pg.client.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`,
        [value],
      );
      return Number(res.rows[0]?.n ?? -1);
    };

    expect(await count("everdict_workspaces", "id", doomed), "the workspace row survived its own delete").toBe(0);
    expect(await count("everdict_workspace_members", "workspace", doomed)).toBe(0);
    expect(
      await count("everdict_agents", "tenant", doomed),
      "a tenant-scoped table the old list never named kept its rows",
    ).toBe(0);

    // The other half of the same guarantee, and the one a sweep derived from the SCHEMA could get wrong in
    // the worst way: every statement is still scoped to one workspace.
    expect(await count("everdict_workspaces", "id", neighbour), "another workspace was deleted too").toBe(1);
    expect(await count("everdict_agents", "tenant", neighbour), "another workspace's rows were swept").toBe(1);
  });

  it("derives a set that covers far more than the eighteen tables the list held", async () => {
    // The count itself is evidence: the repair's claim is that the sweep now follows the schema, and a
    // derivation that quietly resolved a handful of tables would satisfy the deletion assertions above while
    // leaving the drift. Asserted as a floor rather than an exact number, because the schema grows — which is
    // the entire point.
    const res = await pg.client.query<{ n: string | number }>(
      `SELECT count(*) AS n
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = current_schema()
          AND t.table_type = 'BASE TABLE'
          AND c.table_name LIKE 'everdict\\_%'
          AND c.column_name IN ('workspace', 'tenant')`,
    );
    expect(Number(res.rows[0]?.n ?? 0)).toBeGreaterThan(50);
  });

  it("refuses to remove the workspace row when it cannot enumerate what the delete owes", async () => {
    // An empty derived set means the schema query answered nothing — a read that did not happen, not a
    // workspace with no data. Deleting the row on top of that reports success over data nobody looked for
    // (rule `protocol` L5). Driven through a client whose schema reads come back empty while its DELETEs
    // still work, so the refusal is the only thing that can stop it.
    const blind: SqlClient = {
      query: async <R>(text: string, params?: unknown[]) => {
        if (text.includes("information_schema") || text.includes("pg_constraint")) return { rows: [] as R[] };
        return await pg.client.query<R>(text, params);
      },
    };
    const survivor = trustId("ws-blind");
    await new PgWorkspaceStore(pg.client).create({ id: survivor, name: "Blind", owner: trustId("dave") });

    await expect(new PgWorkspaceStore(blind).delete(survivor)).rejects.toThrow(/no tenant-scoped tables/);

    const res = await pg.client.query<{ n: string | number }>(
      "SELECT count(*) AS n FROM everdict_workspaces WHERE id = $1",
      [survivor],
    );
    expect(Number(res.rows[0]?.n ?? 0), "the workspace row was removed over an enumeration that failed").toBe(1);
    await new PgWorkspaceStore(pg.client).delete(survivor);
  });
});
