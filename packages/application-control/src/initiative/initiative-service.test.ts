import type {
  InitiativeRecord,
  InitiativeUpdateRecord,
  IssueGroupBy,
  IssueGroupCount,
  IssuePage,
  IssueRecord,
  ProjectRecord,
} from "@everdict/contracts";
import { ConflictError } from "@everdict/contracts";
import { issueCountsByGroup, issueCountsByTeam, issueSummaryOf } from "@everdict/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { InitiativeListFilter, InitiativeStore } from "../ports/initiative-store.js";
import type { IssueListFilter, IssuePageFilter, IssueStore, IssueTeamCounts } from "../ports/issue-store.js";
import type { ProjectListFilter, ProjectStore } from "../ports/project-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import { InitiativeService } from "./initiative-service.js";

const NOW = "2026-07-31T00:00:00.000Z";

// One generic fake for the three tenant-scoped tracker stores — they share a CRUD shape, and the readiness
// gate only needs list-by-parent plus the outbox rows.
class FakeStore<T extends { id: string; tenant: string }> {
  readonly byId = new Map<string, T>();
  readonly events: OutboxEvent[] = [];

  async create(record: T, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }
  async get(tenant: string, id: string): Promise<T | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }
  async update(tenant: string, id: string, patch: Partial<T>, events?: OutboxEvent[]): Promise<T | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next = { ...current, ...patch, id: current.id, tenant: current.tenant };
    this.byId.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }
  async remove(tenant: string, id: string): Promise<void> {
    this.byId.delete(id);
  }
  all(tenant: string): T[] {
    return [...this.byId.values()].filter((r) => r.tenant === tenant);
  }
}

class FakeIssueStore extends FakeStore<IssueRecord> implements IssueStore {
  async getByIdentifier(tenant: string, identifier: string): Promise<IssueRecord | undefined> {
    return [...this.byId.values()].find((r) => r.tenant === tenant && r.identifier === identifier);
  }
  async getByGithub(): Promise<IssueRecord | undefined> {
    return undefined;
  }
  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    return this.all(tenant).filter((r) => filter?.projectId === undefined || r.projectId === filter.projectId);
  }
  // Derived from this fake's own `list` via the kernel helpers, so it cannot disagree with production.
  async listSummaries(tenant: string, filter?: IssuePageFilter): Promise<IssuePage> {
    return { items: (await this.list(tenant, filter)).map(issueSummaryOf) };
  }
  async countByTeam(tenant: string): Promise<IssueTeamCounts[]> {
    return issueCountsByTeam(await this.list(tenant));
  }
  async countByGroup(tenant: string, groupBy: IssueGroupBy, filter?: IssueListFilter): Promise<IssueGroupCount[]> {
    return issueCountsByGroup(await this.list(tenant, filter), groupBy);
  }
}

class FakeProjectStore extends FakeStore<ProjectRecord> implements ProjectStore {
  async list(tenant: string, filter?: ProjectListFilter): Promise<ProjectRecord[]> {
    const rows = this.all(tenant).filter(
      (r) =>
        (filter?.initiativeId === undefined || r.initiativeIds.includes(filter.initiativeId)) &&
        (filter?.initiativeIds === undefined || r.initiativeIds.some((id) => filter.initiativeIds?.includes(id))),
    );
    return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }
}

class FakeInitiativeStore extends FakeStore<InitiativeRecord> implements InitiativeStore {
  async list(tenant: string, _filter?: InitiativeListFilter): Promise<InitiativeRecord[]> {
    return this.all(tenant);
  }
}

function issue(id: string, projectId: string, status: IssueRecord["status"]): IssueRecord {
  return {
    id,
    tenant: "acme",
    teamId: "team-eng",
    number: 1,
    identifier: "ENG-1",
    formerIdentifiers: [],
    title: `issue ${id}`,
    status,
    priority: "none",
    inTriage: false,
    projectId,
    labelIds: [],
    links: [],
    ...(status === "done" || status === "regressed"
      ? { resolution: { scorecardId: "sc-1", by: "dana", at: NOW } }
      : {}),
    history: [],
    createdBy: "dana",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function project(id: string, initiativeId: string, status: ProjectRecord["status"]): ProjectRecord {
  return {
    id,
    tenant: "acme",
    name: `project ${id}`,
    status,
    teamIds: ["team-1"],
    initiativeIds: [initiativeId],
    memberIds: [],
    milestones: [],
    history: [],
    createdBy: "dana",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("InitiativeService — the completion gate", () => {
  let initiatives: FakeInitiativeStore;
  let projects: FakeProjectStore;
  let issues: FakeIssueStore;
  let ids: number;
  const actor = { subject: "dana" };

  function service() {
    return new InitiativeService({
      store: initiatives,
      projects,
      issues,
      newId: () => `id-${++ids}`,
      now: () => NOW,
    });
  }

  beforeEach(() => {
    initiatives = new FakeInitiativeStore();
    projects = new FakeProjectStore();
    issues = new FakeIssueStore();
    ids = 0;
  });

  it("reports readiness across every project's issues, leading with regressions", async () => {
    const svc = service();
    const initiative = await svc.create({ tenant: "acme", createdBy: "dana", name: "v1 deploy" });
    await projects.create(project("p1", initiative.id, "completed"));
    await projects.create(project("p2", initiative.id, "in_progress"));
    await issues.create(issue("a", "p1", "regressed"));
    await issues.create(issue("b", "p2", "todo"));
    await issues.create(issue("c", "p2", "done"));

    const detail = await svc.detail("acme", initiative.id);
    expect(detail.readiness.ready).toBe(false);
    expect(detail.readiness.openIssues).toBe(2);
    expect(detail.readiness.totalIssues).toBe(3);
    expect(detail.readiness.blockers.map((b) => b.issueId)).toEqual(["a", "b"]);
    expect(detail.readiness.projects.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  it("a posted update carries the health onto the goal, and the sentence stays the record", async () => {
    // The update store is append-only; the fake keeps insertion order so "newest first" is the service's job.
    const rows: InitiativeUpdateRecord[] = [];
    const svc = new InitiativeService({
      store: initiatives,
      projects,
      issues,
      updates: {
        async create(record) {
          rows.push(record);
        },
        async list(_tenant, initiativeId) {
          return rows
            .filter((r) => r.initiativeId === initiativeId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        },
      },
      newId: () => `id-${++ids}`,
      now: () => NOW,
    });
    const initiative = await svc.create({ tenant: "acme", createdBy: "dana", name: "agents people trust" });
    const update = await svc.postUpdate(
      "acme",
      initiative.id,
      { health: "at_risk", body: "The judge rewrite slipped a week." },
      actor,
    );
    expect(update.health).toBe("at_risk");
    expect(rows).toHaveLength(1);
    // The initiative keeps the LATEST health so a row shows it without reading the timeline.
    expect((await svc.get("acme", initiative.id)).health).toBe("at_risk");
    expect(await svc.listUpdates("acme", initiative.id)).toHaveLength(1);
  });

  it("serves an empty timeline when the deployment carries no update store", async () => {
    const svc = service();
    const initiative = await svc.create({ tenant: "acme", createdBy: "dana", name: "agents people trust" });
    expect(await svc.listUpdates("acme", initiative.id)).toEqual([]);
  });

  it("refuses completion while work is open under it — a goal with unfinished work is not reached", async () => {
    const svc = service();
    const initiative = await svc.create({ tenant: "acme", createdBy: "dana", name: "v1 deploy" });
    await projects.create(project("p1", initiative.id, "in_progress"));
    await issues.create(issue("a", "p1", "in_progress"));
    await expect(svc.setStatus("acme", initiative.id, { status: "completed" }, actor)).rejects.toThrow(ConflictError);
  });

  it("a regressed issue inside a COMPLETED project still blocks the release", async () => {
    const svc = service();
    const initiative = await svc.create({ tenant: "acme", createdBy: "dana", name: "v1 deploy" });
    await projects.create(project("p1", initiative.id, "completed"));
    await issues.create(issue("a", "p1", "regressed"));
    await expect(svc.setStatus("acme", initiative.id, { status: "completed" }, actor)).rejects.toThrow(ConflictError);
  });

  it("completes when readiness is clean, and records the override when forced", async () => {
    const svc = service();
    const clean = await svc.create({ tenant: "acme", createdBy: "dana", name: "clean" });
    await projects.create(project("p1", clean.id, "completed"));
    await issues.create(issue("a", "p1", "done"));
    const completed = await svc.setStatus("acme", clean.id, { status: "completed" }, actor);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe(NOW);

    const gapped = await svc.create({ tenant: "acme", createdBy: "dana", name: "gapped" });
    await projects.create(project("p2", gapped.id, "in_progress"));
    await issues.create(issue("b", "p2", "todo"));
    await svc.setStatus("acme", gapped.id, { status: "completed", force: true }, actor);
    const forcedFact = initiatives.events.find((e) => e.payload?.forced === true);
    expect(forcedFact?.kind).toBe("initiative.status_changed");
    expect(forcedFact?.payload).toMatchObject({ openIssues: 1, forced: true });
  });

  it("refuses to delete an initiative that still holds projects", async () => {
    const svc = service();
    const initiative = await svc.create({ tenant: "acme", createdBy: "dana", name: "v1 deploy" });
    await projects.create(project("p1", initiative.id, "in_progress"));
    await expect(svc.remove("acme", initiative.id, { subject: "dana", isAdmin: true })).rejects.toThrow(ConflictError);
  });

  it("counts a sub-initiative's projects, so nesting cannot hide work from the goal", async () => {
    // Given: a parent whose own project is settled, and a child holding open work
    const svc = service();
    const parent = await svc.create({ tenant: "acme", createdBy: "dana", name: "v1 deploy" });
    const child = await svc.create({ tenant: "acme", createdBy: "dana", name: "storage", parentId: parent.id });
    await projects.create(project("p1", parent.id, "in_progress"));
    await projects.create(project("p2", child.id, "in_progress"));
    await issues.create(issue("a", "p1", "done"));
    await issues.create(issue("b", "p2", "todo"));
    // When: the parent's readiness is read
    const readiness = await svc.readiness("acme", parent.id);
    // Then: the child's open issue blocks the parent, and the summary says where it sits
    expect(readiness.ready).toBe(false);
    expect(readiness.openIssues).toBe(1);
    expect(readiness.projects.find((p) => p.id === "p2")?.viaInitiativeId).toBe(child.id);
    // And: completing the parent hits the same gate
    await expect(svc.setStatus("acme", parent.id, { status: "completed" }, actor)).rejects.toThrow(ConflictError);
  });

  it("refuses to re-parent an initiative under its own descendant", async () => {
    const svc = service();
    const parent = await svc.create({ tenant: "acme", createdBy: "dana", name: "v1 deploy" });
    const child = await svc.create({ tenant: "acme", createdBy: "dana", name: "storage", parentId: parent.id });
    await expect(svc.update("acme", parent.id, { parentId: child.id }, actor)).rejects.toThrow(ConflictError);
  });

  it("refuses to delete an initiative that still has sub-initiatives", async () => {
    const svc = service();
    const parent = await svc.create({ tenant: "acme", createdBy: "dana", name: "v1 deploy" });
    await svc.create({ tenant: "acme", createdBy: "dana", name: "storage", parentId: parent.id });
    await expect(svc.remove("acme", parent.id, { subject: "dana", isAdmin: true })).rejects.toThrow(/sub-initiative/);
  });

  it("scopes every read to the workspace — another tenant's initiative does not resolve", async () => {
    const svc = service();
    const initiative = await svc.create({ tenant: "acme", createdBy: "dana", name: "v1 deploy" });
    await expect(svc.get("globex", initiative.id)).rejects.toThrow(/not found/);
  });
});
