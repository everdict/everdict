import type {
  InitiativeRecord,
  IssueRecord,
  ProjectRecord,
  ProjectUpdateRecord,
  TeamRecord,
} from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { InitiativeStore } from "../ports/initiative-store.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { ProjectListFilter, ProjectStore } from "../ports/project-store.js";
import type { TeamStore } from "../ports/team-store.js";
import { ProjectService } from "./project-service.js";

const TENANT = "acme";
const AT = "2026-01-01T00:00:00.000Z";

function project(id: string, over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    tenant: TENANT,
    name: id,
    status: "in_progress",
    teamIds: ["team-1"],
    initiativeIds: [],
    memberIds: [],
    milestones: [],
    history: [],
    createdBy: "u",
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function team(id: string, isDefault = false): TeamRecord {
  return {
    id,
    tenant: TENANT,
    key: id.toUpperCase().slice(0, 4),
    name: id,
    isDefault,
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
    createdBy: "u",
    createdAt: AT,
    updatedAt: AT,
  };
}

// Only what the stranded-issue gate reads: which team an issue is on, and which project it sits in.
function issue(id: string, teamId: string): IssueRecord {
  return {
    id,
    tenant: TENANT,
    teamId,
    number: 1,
    identifier: `${teamId.toUpperCase().slice(0, 3)}-1`,
    formerIdentifiers: [],
    title: id,
    status: "todo",
    priority: "none",
    inTriage: false,
    labelIds: [],
    links: [],
    history: [],
    createdBy: "u",
    createdAt: AT,
    updatedAt: AT,
  };
}

function initiative(id: string): InitiativeRecord {
  return {
    id,
    tenant: TENANT,
    name: id,
    status: "active",
    history: [],
    createdBy: "u",
    createdAt: AT,
    updatedAt: AT,
  };
}

// Fakes at the interface — application-control cannot import @everdict/db (that package binds THESE ports).
function stores(projects: ProjectRecord[], teams: TeamRecord[] = [], initiatives: InitiativeRecord[] = []) {
  const created: ProjectRecord[] = [];
  const seenProjectFilters: ProjectListFilter[] = [];
  const store: ProjectStore = {
    async create(record) {
      created.push(record);
      projects.push(record);
    },
    async get(_t, id) {
      return projects.find((p) => p.id === id);
    },
    async list(_t, filter?: ProjectListFilter) {
      if (filter) seenProjectFilters.push(filter);
      const rows = projects.filter(
        (p) =>
          (filter?.status === undefined || p.status === filter.status) &&
          (filter?.teamId === undefined || p.teamIds.includes(filter.teamId)) &&
          (filter?.initiativeId === undefined || p.initiativeIds.includes(filter.initiativeId)),
      );
      return filter?.limit === undefined ? rows : rows.slice(0, filter.limit);
    },
    async update(_t, id, patch) {
      const at = projects.findIndex((p) => p.id === id);
      if (at < 0) return undefined;
      const next = { ...projects[at], ...patch } as ProjectRecord;
      projects[at] = next;
      return next;
    },
    async remove() {},
  };
  const issues: IssueStore = {
    async create() {},
    async get() {
      return undefined;
    },
    async getByIdentifier() {
      return undefined;
    },
    async getByGithub() {
      return undefined;
    },
    async list(): Promise<IssueRecord[]> {
      return [];
    },
    // The list projection + team aggregate the port grew for the paginated issue list — unused here.
    async listSummaries() {
      return { items: [] };
    },
    async countByTeam() {
      return [];
    },
    async countByGroup() {
      return [];
    },
    async update() {
      return undefined;
    },
    async remove() {},
  };
  const teamStore = {
    async get(_t: string, id: string) {
      return teams.find((x) => x.id === id);
    },
    async getDefault() {
      return teams.find((x) => x.isDefault);
    },
    async list() {
      return teams;
    },
  } as unknown as TeamStore;
  const initiativeStore = {
    async get(_t: string, id: string) {
      return initiatives.find((x) => x.id === id);
    },
    async list() {
      return initiatives;
    },
  } as unknown as InitiativeStore;
  return { store, issues, teams: teamStore, initiatives: initiativeStore, created, seenProjectFilters };
}

describe("ProjectService.list — team and initiative narrowing belong to the store", () => {
  it("passes the team filter straight through instead of deriving it from issues", async () => {
    // Given: a project that NAMES the web team but has no issues yet — the case the derived join got wrong
    const deps = stores([project("alpha", { teamIds: ["web"] }), project("beta", { teamIds: ["mobile"] })]);
    // When
    const rows = await new ProjectService(deps).list(TENANT, { teamId: "web" });
    // Then: it is the team's project from the moment it says so, not from its first issue
    expect(rows.map((p) => p.id)).toEqual(["alpha"]);
    expect(deps.seenProjectFilters).toEqual([{ teamId: "web" }]);
  });

  it("finds a project under every initiative it names", async () => {
    const deps = stores([project("alpha", { initiativeIds: ["ini-a", "ini-b"] })]);
    const service = new ProjectService(deps);
    expect((await service.list(TENANT, { initiativeId: "ini-a" })).map((p) => p.id)).toEqual(["alpha"]);
    expect((await service.list(TENANT, { initiativeId: "ini-b" })).map((p) => p.id)).toEqual(["alpha"]);
  });
});

describe("ProjectService.create — the edges have to point at something real", () => {
  it("lands a project with no team on the workspace default, so it is visible where people look", async () => {
    const deps = stores([], [team("web", true), team("mobile")]);
    const record = await new ProjectService(deps).create({ tenant: TENANT, createdBy: "dana", name: "alpha" });
    expect(record.teamIds).toEqual(["web"]);
  });

  it("keeps the named teams, and records both edges on creation", async () => {
    const deps = stores([], [team("web", true), team("mobile")], [initiative("ini-a")]);
    const record = await new ProjectService(deps).create({
      tenant: TENANT,
      createdBy: "dana",
      name: "alpha",
      teamIds: ["web", "mobile"],
      initiativeIds: ["ini-a"],
    });
    expect(record.teamIds).toEqual(["web", "mobile"]);
    expect(record.initiativeIds).toEqual(["ini-a"]);
  });

  it("refuses an unknown team with a 400 naming it", async () => {
    const deps = stores([], [team("web", true)]);
    await expect(
      new ProjectService(deps).create({ tenant: TENANT, createdBy: "dana", name: "alpha", teamIds: ["ghost"] }),
    ).rejects.toThrow(BadRequestError);
  });

  it("refuses an unknown initiative — a project cannot roll up into nothing", async () => {
    const deps = stores([], [team("web", true)]);
    await expect(
      new ProjectService(deps).create({
        tenant: TENANT,
        createdBy: "dana",
        name: "alpha",
        initiativeIds: ["ghost"],
      }),
    ).rejects.toThrow(/Unknown initiative/);
  });

  it("refuses to create a team-less project in a workspace that has no team — minting one is TeamService's job", async () => {
    // Given: a workspace with no team at all (one that has never filed an issue), so the default-team fallback
    // has nothing to fall back to
    const deps = stores([]);
    // Then: the caller is told to name a team, rather than getting a project no team's list would ever show
    await expect(new ProjectService(deps).create({ tenant: TENANT, createdBy: "dana", name: "alpha" })).rejects.toThrow(
      BadRequestError,
    );
  });
});

describe("ProjectService.update — a project stays somebody's work", () => {
  it("refuses to detach the last team, while an umbrella may be detached freely", async () => {
    const deps = stores(
      [project("alpha", { teamIds: ["web"], initiativeIds: ["ini-a"] })],
      [team("web", true)],
      [initiative("ini-a")],
    );
    const service = new ProjectService(deps);
    const actor = { subject: "dana", isAdmin: true };

    await expect(service.update(TENANT, "alpha", { teamIds: [] }, actor)).rejects.toThrow(BadRequestError);
    expect((await service.update(TENANT, "alpha", { initiativeIds: [] }, actor)).initiativeIds).toEqual([]);
  });

  it("refuses to remove a team whose issues are still in the project, naming the count", async () => {
    // Given: a project both teams work, holding one issue from each
    const deps = stores([project("alpha", { teamIds: ["web", "mobile"] })], [team("web", true), team("mobile")]);
    const held: IssueRecord[] = [
      { ...issue("i-1", "web"), projectId: "alpha" },
      { ...issue("i-2", "mobile"), projectId: "alpha" },
    ];
    deps.issues.list = async () => held;
    const service = new ProjectService(deps);

    // When: the mobile team is dropped from the project while its issue is still in it
    // Then: refused — an issue may only sit in a project its own team is on, so those issues would be stranded
    await expect(
      service.update(TENANT, "alpha", { teamIds: ["web"] }, { subject: "dana", isAdmin: true }),
    ).rejects.toThrow(ConflictError);

    // And once that issue leaves the project, the team can go
    held.pop();
    const updated = await service.update(TENANT, "alpha", { teamIds: ["web"] }, { subject: "dana", isAdmin: true });
    expect(updated.teamIds).toEqual(["web"]);
  });
});

describe("ProjectService — lead, health updates and milestones", () => {
  // The update store is append-only; the fake keeps insertion order so "newest first" is the service's job.
  function withUpdates() {
    const rows: ProjectUpdateRecord[] = [];
    const d = stores([], [team("web", true)]);
    let n = 0;
    const service = new ProjectService({
      ...d,
      updates: {
        async create(record) {
          rows.push(record);
        },
        async list(_t, projectId) {
          return rows.filter((r) => r.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        },
      },
      newId: () => `id-${++n}`,
      now: () => AT,
    });
    return { service, rows, storesRef: d };
  }

  it("records the lead and members on creation", async () => {
    const d = stores([], [team("web", true)]);
    const record = await new ProjectService(d).create({
      tenant: TENANT,
      createdBy: "dana",
      name: "alpha",
      lead: "dana",
      memberIds: ["dana", "erin"],
    });
    expect(record).toMatchObject({ lead: "dana", memberIds: ["dana", "erin"] });
  });

  it("a posted update carries the health onto the project, and the sentence stays the record", async () => {
    const { service, rows } = withUpdates();
    const project = await service.create({ tenant: TENANT, createdBy: "dana", name: "alpha" });
    const update = await service.postUpdate(
      TENANT,
      project.id,
      { health: "at_risk", body: "The judge rewrite slipped a week." },
      { subject: "dana" },
    );
    expect(update.health).toBe("at_risk");
    expect(rows).toHaveLength(1);
    // The project keeps the LATEST health so a row shows it without reading the timeline.
    expect((await service.get(TENANT, project.id)).health).toBe("at_risk");
    expect(await service.listUpdates(TENANT, project.id)).toHaveLength(1);
  });

  it("refuses a health flag with no sentence — a colour nobody can explain is not an update", async () => {
    const { service } = withUpdates();
    const project = await service.create({ tenant: TENANT, createdBy: "dana", name: "alpha" });
    await expect(
      service.postUpdate(TENANT, project.id, { health: "off_track", body: "   " }, { subject: "dana" }),
    ).rejects.toThrow(BadRequestError);
  });

  it("adds milestones in order and refuses a duplicate name", async () => {
    const d = stores([], [team("web", true)]);
    let n = 0;
    const service = new ProjectService({ ...d, newId: () => `id-${++n}`, now: () => AT });
    const project = await service.create({ tenant: TENANT, createdBy: "dana", name: "alpha" });
    const one = await service.addMilestone(TENANT, project.id, { name: "beta cut" }, { subject: "dana" });
    const two = await service.addMilestone(TENANT, project.id, { name: "ship" }, { subject: "dana" });
    expect(two.milestones.map((m) => m.sortOrder)).toEqual([0, 1]);
    expect(one.milestones[0]?.name).toBe("beta cut");
    await expect(service.addMilestone(TENANT, project.id, { name: "ship" }, { subject: "dana" })).rejects.toThrow(
      ConflictError,
    );
  });
});
