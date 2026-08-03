import type { CycleRecord, IssueRecord, TeamRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { CycleListFilter, CycleStore } from "../ports/cycle-store.js";
import type { IssueListFilter, IssueStore } from "../ports/issue-store.js";
import type { TeamStore } from "../ports/team-store.js";
import { CycleService } from "./cycle-service.js";

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
    cycleDurationWeeks: 2,
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
});
