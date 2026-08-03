import type { TeamRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryTeamStore, PgTeamStore } from "./team-store.js";

// The two impls must stay interchangeable (rule db.md): the in-memory store keeps whole records, so a column
// the Pg store forgets to write or read is invisible until production. Sub-team nesting is exactly that shape
// of field — one column, no behaviour of its own — so it is asserted at the SQL level here.

const AT = "2026-08-03T00:00:00.000Z";

const team = (over: Partial<TeamRecord> = {}): TeamRecord => ({
  id: "team-rnt",
  tenant: "acme",
  key: "RNT",
  name: "Runtime",
  isDefault: false,
  issueCounter: 0,
  cycleCounter: 0,
  cycleDurationWeeks: 2,
  triageEnabled: false,
  isPrivate: false,
  history: [],
  createdBy: "dana",
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

function fakeClient(rows: unknown[] = []) {
  const queries: { text: string; params?: unknown[] }[] = [];
  const client: SqlClient = {
    async query<T>(text: string, params?: unknown[]) {
      queries.push({ text, ...(params !== undefined ? { params } : {}) });
      return { rows: rows as T[] };
    },
  };
  return { client, queries };
}

describe("team store — a team's parent survives the round trip", () => {
  it("keeps the parent on an in-memory write", async () => {
    const store = new InMemoryTeamStore();
    await store.create(team({ parentId: "team-plt" }));
    expect((await store.get("acme", "team-rnt"))?.parentId).toBe("team-plt");
  });

  it("writes parent_id on insert", async () => {
    const { client, queries } = fakeClient();
    await new PgTeamStore(client).create(team({ parentId: "team-plt" }));
    expect(queries[0]?.text).toContain("parent_id");
    expect(queries[0]?.params).toContain("team-plt");
  });

  it("reads parent_id back into the record", async () => {
    const { client } = fakeClient([
      {
        id: "team-rnt",
        tenant: "acme",
        key: "RNT",
        name: "Runtime",
        description: null,
        parent_id: "team-plt",
        is_default: false,
        issue_counter: 3,
        history: [],
        created_by: "dana",
        created_at: AT,
        updated_at: AT,
      },
    ]);
    const record = await new PgTeamStore(client).get("acme", "team-rnt");
    expect(record?.parentId).toBe("team-plt");
  });

  it("includes parent_id in the update SET clause — re-parenting must not be a silent no-op", async () => {
    // Given: a stored team (the update path reads the current row first)
    const { client, queries } = fakeClient([
      {
        id: "team-rnt",
        tenant: "acme",
        key: "RNT",
        name: "Runtime",
        description: null,
        parent_id: null,
        is_default: false,
        issue_counter: 0,
        history: [],
        created_by: "dana",
        created_at: AT,
        updated_at: AT,
      },
    ]);
    // When: it is nested under another team
    await new PgTeamStore(client).update("acme", "team-rnt", { parentId: "team-plt", updatedAt: AT });
    // Then: the write actually names the column (the patch map is explicit, so an omission is silent)
    const update = queries.find((q) => q.text.includes("UPDATE everdict_teams"));
    expect(update?.text).toContain("parent_id=");
    expect(update?.params).toContain("team-plt");
  });
});
