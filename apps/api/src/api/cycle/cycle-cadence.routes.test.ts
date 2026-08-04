import { CycleService, IssueService, RunService, TeamService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryCycleStore, InMemoryIssueStore, InMemoryRunStore, InMemoryTeamStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// A team's cadence, over the wire. The settings screen has sent `cycleDurationWeeks` and `triageEnabled` for as
// long as it has existed, and PATCH /teams accepted neither — an unknown key is stripped, so the request
// answered 200 and changed nothing. These assert the round trip rather than the status code.
const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in tracker tests");
  },
};

const ADMIN = { "x-everdict-tenant": "acme" };

function build() {
  const teamStore = new InMemoryTeamStore();
  const issues = new InMemoryIssueStore();
  const teamService = new TeamService({ store: teamStore, issues });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    teamService,
    issueService: new IssueService({ teams: teamService, store: issues }),
    cycleService: new CycleService({ store: new InMemoryCycleStore(), teams: teamStore, issues }),
  });
  return { app };
}

async function team(app: ReturnType<typeof build>["app"], key = "ENG") {
  return (await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key, name: key } })).json();
}

describe("PATCH /teams/:id — the cadence", () => {
  it("saves the cycle settings instead of dropping them on the floor", async () => {
    // Given: a team on the defaults
    const { app } = build();
    const eng = await team(app);
    expect(eng.cyclesEnabled).toBe(false);
    // When: the team turns cycles on and names its own pace
    const res = await app.inject({
      method: "PATCH",
      url: `/teams/${eng.id}`,
      headers: ADMIN,
      payload: { cyclesEnabled: true, cycleDurationWeeks: 3, cycleStartDay: 0, upcomingCycleCount: 1 },
    });
    // Then: the saved record says so, and so does the next read
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      cyclesEnabled: true,
      cycleDurationWeeks: 3,
      cycleStartDay: 0,
      upcomingCycleCount: 1,
    });
    const reread = await app.inject({ method: "GET", url: "/teams/ENG", headers: ADMIN });
    expect(reread.json()).toMatchObject({ cyclesEnabled: true, cycleDurationWeeks: 3 });
  });

  it("saves the triage switch, which travelled the same broken path", async () => {
    const { app } = build();
    const eng = await team(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/teams/${eng.id}`,
      headers: ADMIN,
      payload: { triageEnabled: true },
    });
    expect(res.json().triageEnabled).toBe(true);
  });

  it("refuses a start day that is not a weekday and a window longer than the record allows", async () => {
    const { app } = build();
    const eng = await team(app);
    for (const payload of [{ cycleStartDay: 7 }, { cycleDurationWeeks: 0 }, { upcomingCycleCount: 99 }]) {
      const res = await app.inject({ method: "PATCH", url: `/teams/${eng.id}`, headers: ADMIN, payload });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("GET /cycles?team= — the pipeline", () => {
  it("stands up the iteration the team is in plus the ones its cadence keeps ahead", async () => {
    // Given: a team that has turned cycles on and asked for one spare
    const { app } = build();
    const eng = await team(app);
    await app.inject({
      method: "PATCH",
      url: `/teams/${eng.id}`,
      headers: ADMIN,
      payload: { cyclesEnabled: true, upcomingCycleCount: 1 },
    });
    // When: somebody opens the team's cycles for the first time
    const res = await app.inject({ method: "GET", url: "/cycles?team=ENG", headers: ADMIN });
    // Then: two exist, numbered in the team's own sequence, without anyone planning them
    expect(res.statusCode).toBe(200);
    expect(res.json().map((c: { number: number }) => c.number)).toEqual([2, 1]);
  });

  it("creates nothing for a team that never turned cycles on", async () => {
    const { app } = build();
    await team(app);
    const res = await app.inject({ method: "GET", url: "/cycles?team=ENG", headers: ADMIN });
    expect(res.json()).toEqual([]);
  });

  it("leaves the workspace-wide list alone — a pipeline belongs to a team, not to a query", async () => {
    const { app } = build();
    const eng = await team(app);
    await app.inject({
      method: "PATCH",
      url: `/teams/${eng.id}`,
      headers: ADMIN,
      payload: { cyclesEnabled: true },
    });
    expect((await app.inject({ method: "GET", url: "/cycles", headers: ADMIN })).json()).toEqual([]);
  });
});

describe("GET /cycles/:id — the burn-down", () => {
  it("carries one point per elapsed day alongside the progress rollup", async () => {
    const { app } = build();
    const eng = await team(app);
    // A window that starts today, so exactly one day has elapsed.
    const today = new Date().toISOString().slice(0, 10);
    const planned = await app.inject({
      method: "POST",
      url: "/cycles",
      headers: ADMIN,
      payload: { teamId: eng.id, startsAt: today, endsAt: today },
    });
    const res = await app.inject({ method: "GET", url: `/cycles/${planned.json().id}`, headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json().burndown).toEqual([{ date: today, scope: 0, remaining: 0, remainingIssues: 0 }]);
  });
});
