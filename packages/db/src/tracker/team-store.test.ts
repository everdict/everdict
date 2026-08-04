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
  cyclesEnabled: false,
  cycleDurationWeeks: 2,
  cycleStartDay: 1,
  upcomingCycleCount: 2,
  cycleAutoClose: false,
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

// The columns 0110 added and no store ever touched. `TeamRecordSchema` defaults every one of them, so a row
// read that omits them yields a VALID record carrying the wrong values — which is why these assert the SQL
// itself rather than a round trip through the fake.
describe("team store — the cadence columns survive the round trip", () => {
  const CADENCE_ROW = {
    id: "team-rnt",
    tenant: "acme",
    key: "RNT",
    name: "Runtime",
    description: null,
    parent_id: null,
    is_private: false,
    is_default: false,
    issue_counter: 3,
    cycles_enabled: true,
    cycle_duration_weeks: 3,
    cycle_start_day: 4,
    upcoming_cycle_count: 1,
    cycle_counter: 7,
    triage_enabled: true,
    history: [],
    created_by: "dana",
    created_at: AT,
    updated_at: AT,
  };

  it("writes the cadence, the cycle counter and the triage switch on insert", async () => {
    const { client, queries } = fakeClient();
    await new PgTeamStore(client).create(
      team({ cyclesEnabled: true, cycleDurationWeeks: 3, cycleStartDay: 4, upcomingCycleCount: 1, cycleCounter: 7 }),
    );
    const insert = queries[0];
    expect(insert?.text).toContain("cycles_enabled");
    expect(insert?.text).toContain("cycle_start_day");
    expect(insert?.text).toContain("upcoming_cycle_count");
    expect(insert?.params).toEqual(expect.arrayContaining([true, 3, 4, 1, 7]));
  });

  it("reads them back instead of falling through to the schema defaults", async () => {
    const { client } = fakeClient([CADENCE_ROW]);
    const record = await new PgTeamStore(client).get("acme", "team-rnt");
    expect(record).toMatchObject({
      cyclesEnabled: true,
      cycleDurationWeeks: 3,
      cycleStartDay: 4,
      upcomingCycleCount: 1,
      triageEnabled: true,
    });
  });

  it("names cycle_counter in the update SET clause — two cycles must never share a number", async () => {
    // Given: a team whose counter stands at 7 (the number the last cycle took)
    const { client, queries } = fakeClient([CADENCE_ROW]);
    // When: planning the next one consumes the counter
    await new PgTeamStore(client).update("acme", "team-rnt", { cycleCounter: 8, updatedAt: AT });
    // Then: the increment reaches the row. Dropped, every cycle would be planned as number 1 and the second
    // would collide on everdict_cycles_tenant_team_number.
    const update = queries.find((q) => q.text.includes("UPDATE everdict_teams"));
    expect(update?.text).toContain("cycle_counter=");
    expect(update?.params).toContain(8);
  });

  it("names the cadence columns in the update SET clause — the settings screen must not be a no-op", async () => {
    const { client, queries } = fakeClient([CADENCE_ROW]);
    await new PgTeamStore(client).update("acme", "team-rnt", {
      cyclesEnabled: true,
      cycleDurationWeeks: 4,
      cycleStartDay: 0,
      upcomingCycleCount: 3,
      updatedAt: AT,
    });
    const update = queries.find((q) => q.text.includes("UPDATE everdict_teams"));
    expect(update?.text).toContain("cycles_enabled=");
    expect(update?.text).toContain("cycle_duration_weeks=");
    expect(update?.text).toContain("cycle_start_day=");
    expect(update?.text).toContain("upcoming_cycle_count=");
  });
});
