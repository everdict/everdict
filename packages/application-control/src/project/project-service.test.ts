import type { InitiativeRecord, IssueRecord, ProjectRecord, ProjectUpdateRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { InitiativeStore } from "../ports/initiative-store.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { ProjectListFilter, ProjectStore } from "../ports/project-store.js";
import { ProjectService } from "./project-service.js";

const TENANT = "acme";
const AT = "2026-01-01T00:00:00.000Z";

function project(id: string, over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    tenant: TENANT,
    name: id,
    status: "in_progress",
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

// Fakes at the interface — application-control cannot import @everdict/db (that package binds THESE ports).
function stores(projects: ProjectRecord[], initiatives: InitiativeRecord[] = []) {
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
    // The list projection the port grew for the paginated issue list — unused here.
    async listSummaries() {
      return { items: [] };
    },
    async countByGroup() {
      return [];
    },
    async update() {
      return undefined;
    },
    async remove() {},
  };
  const initiativeStore = {
    async get(_t: string, id: string) {
      return initiatives.find((x) => x.id === id);
    },
    async list() {
      return initiatives;
    },
  } as unknown as InitiativeStore;
  return { store, issues, initiatives: initiativeStore, created, seenProjectFilters };
}

describe("ProjectService.create — the edges have to point at something real", () => {
  it("refuses an unknown initiative — a project cannot roll up into nothing", async () => {
    const deps = stores([]);
    await expect(
      new ProjectService(deps).create({
        tenant: TENANT,
        createdBy: "dana",
        name: "alpha",
        initiativeIds: ["ghost"],
      }),
    ).rejects.toThrow(/Unknown initiative/);
  });
});

describe("ProjectService — lead, health updates and milestones", () => {
  // The update store is append-only; the fake keeps insertion order so "newest first" is the service's job.
  function withUpdates() {
    const rows: ProjectUpdateRecord[] = [];
    const d = stores([]);
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
    const d = stores([]);
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
    const d = stores([]);
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

  it("finds a project under every initiative it names", async () => {
    const deps = stores([project("alpha", { initiativeIds: ["ini-a", "ini-b"] })]);
    const service = new ProjectService(deps);
    expect((await service.list(TENANT, { initiativeId: "ini-a" })).map((p) => p.id)).toEqual(["alpha"]);
    expect((await service.list(TENANT, { initiativeId: "ini-b" })).map((p) => p.id)).toEqual(["alpha"]);
  });
});
