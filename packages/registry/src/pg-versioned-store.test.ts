import type { SqlClient } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { PgVersionedStore } from "./pg-versioned-store.js";

// Regression: `listMeta` must carry the OWNING TEAM.
//
// It once did not, and nothing caught it — the unit fakes returned a `team_id` the query never asked for, so every
// list looked owner-less while the rows in Postgres were owned. The visible symptom was a team filter that matched
// nothing: `GET /harnesses?team=<the team that owns them>` answered `[]`. What locks it here is the SQL itself —
// the column has to be REQUESTED, not merely returnable.
interface Row {
  tenant: string;
  id: string;
  version: string;
  created_at: string;
  created_by: string | null;
  team_id: string | null;
  deleted_at: number | null;
}

function fake(rows: Row[]): { client: SqlClient; queries: string[]; calls: Array<[string, unknown[]]> } {
  const queries: string[] = [];
  const calls: Array<[string, unknown[]]> = [];
  const client: SqlClient = {
    async query<R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: R[] }> {
      queries.push(text);
      calls.push([text, params]);
      const live = (r: Row) => r.deleted_at === null;
      if (text.startsWith("SELECT DISTINCT id")) {
        const ids = [...new Set(rows.filter((r) => r.tenant === params[0] && live(r)).map((r) => r.id))];
        return { rows: ids.map((id) => ({ id })) as R[] };
      }
      // ownsId probe (listIds → ownerOf) and ownerVersions — both needed before listMeta reaches its own query.
      if (text.startsWith("SELECT 1 FROM")) {
        const hit = rows.some((r) => r.tenant === params[0] && r.id === params[1] && live(r));
        return { rows: (hit ? [{ one: 1 }] : []) as R[] };
      }
      if (text.startsWith("SELECT version FROM")) {
        return {
          rows: rows
            .filter((r) => r.tenant === params[0] && r.id === params[1] && live(r))
            .map((r) => ({ version: r.version })) as R[],
        };
      }
      if (text.startsWith("SELECT version, created_at")) {
        const matched = rows.filter((r) => r.tenant === params[0] && r.id === params[1] && live(r));
        // The fake answers ONLY what the query asked for — otherwise it papers over a missing column, which is
        // exactly how the original defect survived its tests.
        const wantsTeam = text.includes("team_id");
        return {
          rows: matched.map((r) => ({
            version: r.version,
            created_at: r.created_at,
            created_by: r.created_by,
            ...(wantsTeam ? { team_id: r.team_id } : {}),
          })) as R[],
        };
      }
      return { rows: [] as R[] };
    },
  };
  return { client, queries, calls };
}

function row(over: Partial<Row> = {}): Row {
  return {
    tenant: "acme",
    id: "h",
    version: "1.0.0",
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "u",
    team_id: "web",
    deleted_at: null,
    ...over,
  };
}

function store(client: SqlClient, teamId: boolean) {
  return new PgVersionedStore<{ id: string; version: string }>(client, {
    table: "everdict_things",
    column: "spec",
    label: "thing",
    parse: (v) => v as { id: string; version: string },
    softDelete: true,
    createdBy: true,
    ...(teamId ? { teamId: true } : {}),
  });
}

describe("PgVersionedStore.listMeta — the owning team travels with the row", () => {
  it("selects team_id and reports it, so a team filter can match", async () => {
    // Given: one owned version
    const { client, queries } = fake([row()]);
    // When
    const metas = await store(client, true).listMeta("acme");
    // Then: the column was ASKED for, and the answer carries it
    expect(queries.some((q) => q.includes("team_id"))).toBe(true);
    expect(metas[0]?.teamId).toBe("web");
  });

  it("takes the owner off the SEMVER-latest version, not the last one registered", async () => {
    const { client } = fake([
      row({ version: "2.0.0", team_id: "web", created_at: "2026-01-01T00:00:00.000Z" }),
      row({ version: "1.9.0", team_id: "mobile", created_at: "2026-06-01T00:00:00.000Z" }),
    ]);
    const metas = await store(client, true).listMeta("acme");
    expect(metas[0]?.latestVersion).toBe("2.0.0");
    expect(metas[0]?.teamId).toBe("web");
  });

  it("omits the team for an unowned row — absent must not become a team id", async () => {
    const { client } = fake([row({ team_id: null })]);
    expect((await store(client, true).listMeta("acme"))[0]?.teamId).toBeUndefined();
  });

  it("never asks for the column on a table that has none", async () => {
    const { client, queries } = fake([row()]);
    const metas = await store(client, false).listMeta("acme");
    expect(queries.some((q) => q.includes("team_id"))).toBe(false);
    expect(metas[0]?.teamId).toBeUndefined();
  });
});

describe("PgVersionedStore.moveToTeam — ownership transfer is entity-wide", () => {
  it("updates every version of the id in one statement, keyed by (tenant, id) only", async () => {
    const { client, calls } = fake([row({ version: "1.0.0" }), row({ version: "2.0.0" })]);

    await store(client, true).moveToTeam("acme", "h", "mobile");

    const update = calls.find(([text]) => text.startsWith("UPDATE"));
    expect(update?.[0]).toBe("UPDATE everdict_things SET team_id = $3 WHERE tenant = $1 AND id = $2");
    expect(update?.[1]).toEqual(["acme", "h", "mobile"]);
  });

  it("does NOT exclude tombstones — a revived version must not reappear under the previous team", async () => {
    const { client, calls } = fake([row()]);
    await store(client, true).moveToTeam("acme", "h", "mobile");
    // The UPDATE carries no `deleted_at IS NULL`: reviving is re-registering identical content, and it must not
    // walk the version back across a team boundary.
    expect(calls.find(([text]) => text.startsWith("UPDATE"))?.[0]).not.toContain("deleted_at");
  });

  it("is NotFound for an id with no live version of its own — an invisible entity is not movable", async () => {
    const { client, calls } = fake([row({ deleted_at: 1 })]);
    await expect(store(client, true).moveToTeam("acme", "h", "mobile")).rejects.toMatchObject({ status: 404 });
    expect(calls.some(([text]) => text.startsWith("UPDATE"))).toBe(false);
  });
});
