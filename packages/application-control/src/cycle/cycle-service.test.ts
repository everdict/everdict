import type { CycleRecord, IssueRecord, TeamRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { CycleListFilter, CycleStore } from "../ports/cycle-store.js";
import type { IssueListFilter, IssueStore } from "../ports/issue-store.js";
import type { TeamStore } from "../ports/team-store.js";
import { CYCLE_CADENCE_ACTOR, CycleService } from "./cycle-service.js";

const NOW = "2026-08-03T00:00:00.000Z";
const TODAY = "2026-08-03";

function team(over: Partial<TeamRecord> = {}): TeamRecord {
  return {
    id: "team-eng",
    tenant: "acme",
    key: "ENG",
    name: "Eng",
    isDefault: true,
    issueCounter: 0,
    cycleCounter: 0,
    cyclesEnabled: true,
    cycleDurationWeeks: 2,
    // TODAY is a Monday, so a Monday cadence keeps every window in these tests readable.
    cycleStartDay: 1,
    upcomingCycleCount: 0,
    cycleAutoClose: false,
    triageEnabled: false,
    isPrivate: false,
    history: [],
    createdBy: "dana",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function issue(id: string, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id,
    tenant: "acme",
    teamId: "team-eng",
    number: 1,
    identifier: `ENG-${id}`,
    formerIdentifiers: [],
    title: id,
    status: "todo",
    priority: "none",
    inTriage: false,
    labelIds: [],
    links: [],
    history: [],
    createdBy: "dana",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

// Fakes at the interface — application-control cannot import @everdict/db (that package binds THESE ports).
function deps(teams: TeamRecord[] = [team()], issues: IssueRecord[] = []) {
  const cycles: CycleRecord[] = [];
  const store: CycleStore = {
    async create(record) {
      cycles.push(record);
    },
    async get(_t, id) {
      return cycles.find((c) => c.id === id);
    },
    async list(_t, filter?: CycleListFilter) {
      const rows = cycles
        .filter(
          (c) =>
            (filter?.teamId === undefined || c.teamId === filter.teamId) &&
            (filter?.open !== true || c.completedAt === undefined),
        )
        .sort((a, b) => b.number - a.number);
      return filter?.limit === undefined ? rows : rows.slice(0, filter.limit);
    },
    async update(_t, id, patch) {
      const at = cycles.findIndex((c) => c.id === id);
      if (at < 0) return undefined;
      const next = { ...cycles[at], ...patch } as CycleRecord;
      cycles[at] = next;
      return next;
    },
    async remove(_t, id) {
      const at = cycles.findIndex((c) => c.id === id);
      if (at >= 0) cycles.splice(at, 1);
    },
  };
  const teamStore = {
    async get(_t: string, id: string) {
      return teams.find((x) => x.id === id);
    },
    async update(_t: string, id: string, patch: Partial<TeamRecord>) {
      const at = teams.findIndex((x) => x.id === id);
      if (at < 0) return undefined;
      const next = { ...teams[at], ...patch } as TeamRecord;
      teams[at] = next;
      return next;
    },
  } as unknown as TeamStore;
  const issueStore = {
    async list(_t: string, filter?: IssueListFilter) {
      const rows = issues.filter((i) => filter?.cycleId === undefined || i.cycleId === filter.cycleId);
      return filter?.limit === undefined ? rows : rows.slice(0, filter.limit);
    },
    async update(_t: string, id: string, patch: Partial<IssueRecord>) {
      const at = issues.findIndex((i) => i.id === id);
      if (at < 0) return undefined;
      const next = { ...issues[at], ...patch } as IssueRecord;
      issues[at] = next;
      return next;
    },
  } as unknown as IssueStore;
  return { store, teams: teamStore, issues: issueStore, cycles, issueRows: issues, teamRows: teams };
}

describe("CycleService — a team's iterations", () => {
  let ids: number;
  const actor = { subject: "dana" };
  beforeEach(() => {
    ids = 0;
  });
  const service = (d: ReturnType<typeof deps>) =>
    new CycleService({ ...d, newId: () => `cycle-${++ids}`, now: () => NOW });

  it("numbers cycles per team and proposes the window from the team's cadence", async () => {
    // Given: a team on a two-week cadence with no cycles yet
    const d = deps();
    const svc = service(d);
    // When: two cycles are planned back to back
    const first = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    const second = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    // Then: the numbers are the team's sequence, and the second starts the day after the first ends
    expect(first).toMatchObject({ number: 1, startsAt: TODAY, endsAt: "2026-08-16" });
    expect(second).toMatchObject({ number: 2, startsAt: "2026-08-17", endsAt: "2026-08-30" });
  });

  it("refuses half a window — one date is a mistake, not a shorthand", async () => {
    const svc = service(deps());
    await expect(
      svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng", startsAt: "2026-09-01" }),
    ).rejects.toThrow(BadRequestError);
  });

  it("counts what the cycle holds — issues by count, points by estimate", async () => {
    const d = deps(undefined, [
      issue("a", { cycleId: "cycle-1", estimate: 3 }),
      issue("b", { cycleId: "cycle-1", estimate: 5, status: "done" }),
      issue("c", { cycleId: "cycle-1" }), // no estimate: real work, zero points
    ]);
    const svc = service(d);
    const cycle = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    const detail = await svc.detail("acme", cycle.id);
    expect(detail.progress).toEqual({ total: 3, open: 2, done: 1, scope: 8, completedScope: 5, estimated: 2 });
    expect(detail.state).toBe("active");
  });

  it("closes an iteration and carries the unfinished work into the next one", async () => {
    const d = deps(undefined, [issue("a", { cycleId: "cycle-1" }), issue("b", { cycleId: "cycle-1", status: "done" })]);
    const svc = service(d);
    const first = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    const next = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    // When
    const closed = await svc.complete("acme", first.id, { moveUnfinishedTo: next.id }, actor);
    // Then: the close records how much was left, and the open issue moved
    expect(closed.completedAt).toBe(NOW);
    expect(closed.history.at(-1)?.detail).toMatchObject({ carriedOver: 1 });
    expect(d.issueRows.find((i) => i.id === "a")?.cycleId).toBe(next.id);
    expect(d.issueRows.find((i) => i.id === "b")?.cycleId).toBe(first.id); // settled work stays where it happened
  });

  it("refuses to carry work into another team's cycle", async () => {
    const d = deps([team(), team({ id: "team-mob", key: "MOB", name: "Mobile", isDefault: false })]);
    const svc = service(d);
    const mine = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    const theirs = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-mob" });
    await expect(svc.complete("acme", mine.id, { moveUnfinishedTo: theirs.id }, actor)).rejects.toThrow(
      BadRequestError,
    );
  });

  it("refuses to edit or re-close a finished iteration", async () => {
    const svc = service(deps());
    const cycle = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    await svc.complete("acme", cycle.id, {}, actor);
    await expect(svc.update("acme", cycle.id, { name: "renamed" }, actor)).rejects.toThrow(ConflictError);
    await expect(svc.complete("acme", cycle.id, {}, actor)).rejects.toThrow(ConflictError);
  });

  it("refuses to delete a cycle that still holds issues", async () => {
    const d = deps(undefined, [issue("a", { cycleId: "cycle-1" })]);
    const svc = service(d);
    const cycle = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    await expect(svc.remove("acme", cycle.id, { subject: "dana", isAdmin: true })).rejects.toThrow(ConflictError);
  });

  it("draws the burn-down from the issues' own status history", async () => {
    // Given: five points in the cycle, three of which were resolved on the second day
    const d = deps(undefined, [
      issue("a", {
        cycleId: "cycle-1",
        estimate: 3,
        status: "done",
        history: [
          { at: "2026-08-04T10:00:00.000Z", by: "dana", event: "resolved", detail: { from: "todo", to: "done" } },
        ],
      }),
      issue("b", { cycleId: "cycle-1", estimate: 2 }),
    ]);
    // When: the cycle is read on its third day
    const svc = new CycleService({ ...d, newId: () => "cycle-1", now: () => "2026-08-05T00:00:00.000Z" });
    const cycle = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    const detail = await svc.detail("acme", cycle.id);
    // Then: one point per elapsed day, dropping on the day the work actually settled
    expect(detail.burndown).toEqual([
      { date: "2026-08-03", scope: 5, remaining: 5, remainingIssues: 2 },
      { date: "2026-08-04", scope: 5, remaining: 2, remainingIssues: 1 },
      { date: "2026-08-05", scope: 5, remaining: 2, remainingIssues: 1 },
    ]);
  });

  it("records the destination on each carried-over issue, so the next cycle's burn-down knows when it arrived", async () => {
    // Given: an unfinished issue in a cycle that is about to close
    const d = deps(undefined, [issue("a", { cycleId: "cycle-1", estimate: 3 })]);
    const svc = service(d);
    const first = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    const next = await svc.create({ tenant: "acme", createdBy: "dana", teamId: "team-eng" });
    // When: the iteration is closed carrying it forward
    await svc.complete("acme", first.id, { moveUnfinishedTo: next.id }, actor);
    // Then: the move is in the issue's own history with BOTH ends named — a straight store write would have
    // moved the row silently and the destination's curve would count it from day one.
    const moved = d.issueRows.find((i) => i.id === "a");
    expect(moved?.cycleId).toBe(next.id);
    expect(moved?.history.at(-1)).toMatchObject({
      event: "updated",
      detail: { changed: ["cycle"], cycleFrom: first.id, cycleTo: next.id },
    });
  });
});

// Provisioning — the half that makes cycles feel like they are simply there. A team-scoped list read stands up
// what the cadence says should exist; nothing else does, and no timer is involved.
describe("CycleService — the cadence keeps the pipeline stocked", () => {
  let ids: number;
  beforeEach(() => {
    ids = 0;
  });
  const service = (d: ReturnType<typeof deps>) =>
    new CycleService({ ...d, newId: () => `cycle-${++ids}`, now: () => NOW });

  it("stands up the current cycle plus the upcoming ones on the first team-scoped read", async () => {
    // Given: a team with cycles on, two ahead, and nothing planned
    const d = deps([team({ upcomingCycleCount: 2 })]);
    // When: somebody opens the team's cycles
    const rows = await service(d).list("acme", { teamId: "team-eng" });
    // Then: it is inside one and has two more waiting, numbered in its own sequence
    expect(rows.map((c) => [c.number, c.startsAt])).toEqual([
      [3, "2026-08-31"],
      [2, "2026-08-17"],
      [1, TODAY],
    ]);
    expect(d.teamRows[0]?.cycleCounter).toBe(3);
  });

  it("credits a provisioned cycle to the cadence, not to whoever opened the screen", async () => {
    const d = deps([team({ upcomingCycleCount: 0 })]);
    const [planted] = await service(d).list("acme", { teamId: "team-eng" });
    expect(planted?.createdBy).toBe(CYCLE_CADENCE_ACTOR);
  });

  it("plans nothing on the next read — the plan is computed from what is already there", async () => {
    const d = deps([team({ upcomingCycleCount: 1 })]);
    const svc = service(d);
    await svc.list("acme", { teamId: "team-eng" });
    const second = await svc.list("acme", { teamId: "team-eng" });
    expect(second).toHaveLength(2);
    expect(d.cycles).toHaveLength(2);
  });

  it("creates nothing for a team that never turned cycles on", async () => {
    const d = deps([team({ cyclesEnabled: false })]);
    expect(await service(d).list("acme", { teamId: "team-eng" })).toEqual([]);
    expect(d.cycles).toEqual([]);
  });

  it("leaves the workspace-wide read alone — a pipeline belongs to a team, not to a query", async () => {
    const d = deps([team()]);
    expect(await service(d).list("acme")).toEqual([]);
    expect(d.cycles).toEqual([]);
  });

  // Auto-close is OPT-IN. everdict's default is that a cycle nobody closed keeps showing (it is a cycle
  // somebody forgot, and that is the signal); a team on a settled rhythm switches to Linear's behaviour.
  it("leaves an expired cycle open by default — a forgotten cycle is not tidied away", async () => {
    // Given: a team whose only cycle ended a week ago, auto-close OFF
    const d = deps([team({ upcomingCycleCount: 0 })]);
    const svc = new CycleService({ ...d, newId: () => "cycle-1", now: () => "2026-07-01T00:00:00.000Z" });
    await svc.list("acme", { teamId: "team-eng" });
    // When: somebody opens the list a month later
    const later = new CycleService({ ...d, newId: () => "cycle-2", now: () => "2026-08-03T00:00:00.000Z" });
    const rows = await later.list("acme", { teamId: "team-eng" });
    // Then: the expired one is still there, unclosed, alongside the fresh one
    expect(rows.find((c) => c.id === "cycle-1")?.completedAt).toBeUndefined();
    expect(rows).toHaveLength(2);
  });

  it("closes an expired cycle and carries its work forward when the team asked for that", async () => {
    // Given: a team on auto-close whose cycle ran out with an issue still open
    const issues = [issue("a", { cycleId: "cycle-1" })];
    const d = deps([team({ upcomingCycleCount: 0, cycleAutoClose: true })], issues);
    const svc = new CycleService({ ...d, newId: () => "cycle-1", now: () => "2026-07-01T00:00:00.000Z" });
    await svc.list("acme", { teamId: "team-eng" });
    // When: the list is read after the window ran out
    let n = 1;
    const later = new CycleService({ ...d, newId: () => `cycle-${++n}`, now: () => "2026-08-03T00:00:00.000Z" });
    const rows = await later.list("acme", { teamId: "team-eng" });
    // Then: it closed itself, a fresh one stands in its place, and the open work moved into it
    expect(rows.find((c) => c.id === "cycle-1")?.completedAt).toBeDefined();
    const standing = rows.filter((c) => c.completedAt === undefined);
    expect(standing).toHaveLength(1);
    expect(d.issueRows.find((i) => i.id === "a")?.cycleId).toBe(standing[0]?.id);
  });

  it("credits the auto-close to the cadence, not to whoever opened the screen", async () => {
    const d = deps([team({ upcomingCycleCount: 0, cycleAutoClose: true })]);
    await new CycleService({ ...d, newId: () => "cycle-1", now: () => "2026-07-01T00:00:00.000Z" }).list("acme", {
      teamId: "team-eng",
    });
    let n = 1;
    const rows = await new CycleService({
      ...d,
      newId: () => `cycle-${++n}`,
      now: () => "2026-08-03T00:00:00.000Z",
    }).list("acme", { teamId: "team-eng" });
    const closed = rows.find((c) => c.id === "cycle-1");
    expect(closed?.history.at(-1)).toMatchObject({ event: "completed", by: CYCLE_CADENCE_ACTOR });
  });

  it("tops the pipeline back up after an iteration is closed", async () => {
    // Given: a team keeping one cycle ahead, both of which it has now closed
    const d = deps([team({ upcomingCycleCount: 1 })]);
    const svc = service(d);
    const [ahead, running] = await svc.list("acme", { teamId: "team-eng" });
    if (!running || !ahead) throw new Error("provisioning should have planted two cycles");
    await svc.complete("acme", running.id, {}, { subject: "dana" });
    await svc.complete("acme", ahead.id, {}, { subject: "dana" });
    // When: the team opens its cycles again
    const rows = await svc.list("acme", { teamId: "team-eng" });
    // Then: two fresh ones stand up, continuing the sequence rather than restarting it
    expect(rows.filter((c) => c.completedAt === undefined).map((c) => c.number)).toEqual([4, 3]);
  });
});
