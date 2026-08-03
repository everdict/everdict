import type { IssueRecord, ProjectRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { IssueListFilter, IssueStore } from "../ports/issue-store.js";
import type { ProjectListFilter, ProjectStore } from "../ports/project-store.js";
import { ProjectService } from "./project-service.js";

const TENANT = "acme";

function project(id: string, over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    tenant: TENANT,
    name: id,
    status: "in_progress",
    history: [],
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function issue(id: string, teamId: string, projectId?: string): IssueRecord {
  return {
    id,
    tenant: TENANT,
    teamId,
    number: 1,
    identifier: `${teamId.toUpperCase()}-1`,
    title: id,
    status: "todo",
    labelIds: [],
    links: [],
    history: [],
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

// Fakes at the interface — application-control cannot import @everdict/db (that package binds THESE ports).
function stores(projects: ProjectRecord[], issues: IssueRecord[]) {
  const seenIssueFilters: IssueListFilter[] = [];
  const store: ProjectStore = {
    async create() {},
    async get(_t, id) {
      return projects.find((p) => p.id === id);
    },
    async list(_t, filter?: ProjectListFilter) {
      const rows = projects.filter((p) => filter?.status === undefined || p.status === filter.status);
      return filter?.limit === undefined ? rows : rows.slice(0, filter.limit);
    },
    async update() {
      return undefined;
    },
    async remove() {},
  };
  const issueStore: IssueStore = {
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
    async list(_t, filter?: IssueListFilter) {
      if (filter) seenIssueFilters.push(filter);
      return issues.filter((i) => filter?.teamId === undefined || i.teamId === filter.teamId);
    },
    async update() {
      return undefined;
    },
    async remove() {},
  };
  return { store, issues: issueStore, seenIssueFilters };
}

describe("ProjectService.list — the team filter is derived from issues", () => {
  it("returns only the projects the team has issues in", async () => {
    // Given: web is working on alpha, mobile on beta
    const { store, issues } = stores(
      [project("alpha"), project("beta"), project("gamma")],
      [issue("i1", "web", "alpha"), issue("i2", "mobile", "beta")],
    );
    const service = new ProjectService({ store, issues });
    // When
    const rows = await service.list(TENANT, { teamId: "web" });
    // Then
    expect(rows.map((p) => p.id)).toEqual(["alpha"]);
  });

  it("ignores the team's issues that sit in no project", async () => {
    const { store, issues } = stores([project("alpha")], [issue("i1", "web"), issue("i2", "web", "alpha")]);
    const rows = await new ProjectService({ store, issues }).list(TENANT, { teamId: "web" });
    expect(rows.map((p) => p.id)).toEqual(["alpha"]);
  });

  it("is empty for a team that has not started work — not the whole workspace", async () => {
    const { store, issues } = stores([project("alpha"), project("beta")], []);
    const rows = await new ProjectService({ store, issues }).list(TENANT, { teamId: "web" });
    expect(rows).toEqual([]);
  });

  it("applies the limit AFTER narrowing, so it cannot slice the team's projects away", async () => {
    // Given: the team owns the LAST project of three; a limit applied first would drop it
    const { store, issues } = stores(
      [project("alpha"), project("beta"), project("gamma")],
      [issue("i1", "web", "gamma")],
    );
    const rows = await new ProjectService({ store, issues }).list(TENANT, { teamId: "web", limit: 1 });
    expect(rows.map((p) => p.id)).toEqual(["gamma"]);
  });

  it("combines with the status filter", async () => {
    const { store, issues } = stores(
      [project("alpha", { status: "completed" }), project("beta")],
      [issue("i1", "web", "alpha"), issue("i2", "web", "beta")],
    );
    const rows = await new ProjectService({ store, issues }).list(TENANT, { teamId: "web", status: "completed" });
    expect(rows.map((p) => p.id)).toEqual(["alpha"]);
  });

  it("does not touch the issue store at all when no team is asked for", async () => {
    const { store, issues, seenIssueFilters } = stores([project("alpha")], [issue("i1", "web", "alpha")]);
    const rows = await new ProjectService({ store, issues }).list(TENANT, {});
    expect(rows.map((p) => p.id)).toEqual(["alpha"]);
    expect(seenIssueFilters).toEqual([]);
  });
});
