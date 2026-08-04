import {
  ConflictError,
  ForbiddenError,
  type InitiativeReadiness,
  type InitiativeRecord,
  type InitiativeStatus,
  type InitiativeUpdateRecord,
  type IssueRecord,
  NotFoundError,
  type TrackerHealth,
} from "@everdict/contracts";
import { ISSUE_STATUSES, ISSUE_STATUS_CATEGORY, type ProjectRecord } from "@everdict/contracts";
import type { InitiativeDetailResponse, InitiativeListItem, InitiativeProgress } from "@everdict/contracts/wire";
import {
  Initiative,
  type InitiativeEditInput,
  type InitiativeTransition,
  type ProjectIssueCount,
  initiativeProgress,
  initiativeReadiness,
  ownedByAnyVisibleTeam,
} from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { InitiativeListFilter, InitiativeStore, InitiativeUpdateStore } from "../ports/initiative-store.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ProjectStore } from "../ports/project-store.js";

// The goal several projects work toward. Its one interesting operation is completion, which is a GATE: it reads
// the live progress across every project's issues and refuses while anything is open. Stores are injected
// directly (never peer services) so that read is one fan-out, not a chain of service calls.

// A goal nobody has put work under yet — a real answer, and the one a brand-new initiative gives.
const EMPTY_PROGRESS: InitiativeProgress = { open: 0, total: 0, projects: 0 };

// "Open" has ONE definition in this codebase (records/tracker.ts): anything whose category is neither completed
// nor canceled — `regressed` included. Derived from the category table rather than listed again, so the count a
// list row shows can never disagree with the gate.
const OPEN_ISSUE_STATUSES = ISSUE_STATUSES.filter(
  (status) => ISSUE_STATUS_CATEGORY[status] !== "completed" && ISSUE_STATUS_CATEGORY[status] !== "canceled",
);

export interface InitiativeActor {
  subject: string;
  isAdmin?: boolean;
}

export interface CreateInitiativeInput {
  tenant: string;
  createdBy: string;
  name: string;
  description?: string;
  parentId?: string;
  lead?: string;
  targetDate?: string;
}

export interface InitiativeServiceDeps {
  store: InitiativeStore;
  projects: ProjectStore;
  issues: IssueStore;
  // The posted-update timeline. Absent = this deployment does not carry initiative updates, and the health
  // routes report it as such rather than pretending the goal has never been reported on.
  updates?: InitiativeUpdateStore;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

export class InitiativeService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: InitiativeServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateInitiativeInput): Promise<InitiativeRecord> {
    if (input.parentId !== undefined) await this.get(input.tenant, input.parentId); // 404 if it is not ours
    const record = Initiative.newInitiative({
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.lead !== undefined ? { lead: input.lead } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      createdBy: input.createdBy,
      now: this.now(),
    });
    const stamped = stampFacts(record.tenant, Initiative.creationFacts(record), { newId: this.newId, now: this.now });
    await this.deps.store.create(
      record,
      stamped.map((s) => s.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return record;
  }

  // The list carries each goal's progress, because a list of goals with no answer to "how far along" is a list
  // of names. It is THREE queries for the whole page, not a fan-out per row: every initiative (the tree the
  // roll-up walks), every project claimed by one, and ONE aggregate counting issues per project — twice, since
  // "open" and "total" are two filters over the same GROUP BY. The detail's fan-out stays where it belongs: it
  // is the read that also has to NAME the remaining issues.
  async list(tenant: string, filter?: InitiativeListFilter): Promise<InitiativeListItem[]> {
    const rows = await this.deps.store.list(tenant, filter);
    if (rows.length === 0) return [];
    // The whole tree, not the filtered page: a parent's progress counts a descendant the filter dropped. Only
    // a filter that actually narrows costs the second read — an empty filter object is the same set.
    const narrowed = filter?.status !== undefined || filter?.limit !== undefined;
    const all = narrowed ? await this.deps.store.list(tenant) : rows;
    const projects = await this.deps.projects.list(tenant, { initiativeIds: all.map((row) => row.id) });
    const progress = initiativeProgress(all, projects, await this.countsByProject(tenant, projects));
    return rows.map((row) => ({ ...row, progress: progress.get(row.id) ?? EMPTY_PROGRESS }));
  }

  // open/total per project in two aggregates. `countByGroup` returns one row per group under a filter, so the
  // open pass is the same query narrowed to the open statuses — never a query per project.
  private async countsByProject(
    tenant: string,
    projects: readonly ProjectRecord[],
  ): Promise<Map<string, ProjectIssueCount>> {
    const counts = new Map<string, ProjectIssueCount>();
    if (projects.length === 0) return counts;
    const projectIds = projects.map((project) => project.id);
    const [total, open] = await Promise.all([
      this.deps.issues.countByGroup(tenant, "project", { projectIds }),
      this.deps.issues.countByGroup(tenant, "project", { projectIds, statuses: OPEN_ISSUE_STATUSES }),
    ]);
    for (const row of total) {
      if (row.key === null) continue; // the unset bucket is "no project", which no goal claims
      counts.set(row.key, { open: 0, total: row.count });
    }
    for (const row of open) {
      if (row.key === null) continue;
      const current = counts.get(row.key);
      if (current !== undefined) current.open = row.count;
    }
    return counts;
  }

  async get(tenant: string, id: string): Promise<InitiativeRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `initiative '${id}' not found.`);
    return record;
  }

  // `visibleTeams` is the reader's ceiling (`TeamService.visibleTeamIds` — undefined when nothing is hidden).
  // It narrows WHAT IS LISTED, never what is counted: a goal's progress is one number, the same for everybody,
  // because "how far along is this" stops meaning anything if it depends on who asks. What a private team is
  // owed is that its projects and its open issues are not NAMED to outsiders — a total identifies nothing.
  async detail(tenant: string, id: string, visibleTeams?: string[]): Promise<InitiativeDetailResponse> {
    const record = await this.get(tenant, id);
    return { ...record, readiness: await this.readiness(tenant, id, visibleTeams) };
  }

  // How far along the goal is: every project under it — including the ones claimed by a DESCENDANT initiative —
  // each project's issues, one answer. Nesting exists so a big bet can decompose, and a parent that reported
  // "nothing left" while a sub-initiative was still working would make the decomposition a way to hide work
  // from the goal it belongs to.
  async readiness(tenant: string, id: string, visibleTeams?: string[]): Promise<InitiativeReadiness> {
    const scope = await this.subtreeIds(tenant, id);
    const projects = await this.deps.projects.list(tenant, { initiativeIds: scope });
    const issuesByProject = new Map<string, IssueRecord[]>();
    for (const project of projects)
      issuesByProject.set(project.id, await this.deps.issues.list(tenant, { projectId: project.id }));
    const full = initiativeReadiness(id, projects, issuesByProject);
    if (visibleTeams === undefined) return full;
    // Counted over everything (above), listed only where the reader may look. A blocker names an issue by its
    // identifier and title, so it is hidden with the project it sits in.
    const teamsOf = new Map(projects.map((project) => [project.id, project]));
    const visible = (projectId: string | undefined): boolean =>
      projectId === undefined || ownedByAnyVisibleTeam(teamsOf.get(projectId) ?? {}, visibleTeams);
    return {
      ...full,
      projects: full.projects.filter((project) => visible(project.id)),
      blockers: full.blockers.filter((blocker) => visible(blocker.projectId)),
    };
  }

  // The initiative plus every descendant. One list of the workspace's initiatives and an in-memory walk: a
  // workspace holds a handful of them, and a query per level would cost a round trip per level of nesting for
  // the same answer. Visited-set guarded, so even a cycle written by an older build terminates here.
  private async subtreeIds(tenant: string, rootId: string): Promise<string[]> {
    const all = await this.deps.store.list(tenant);
    const childrenOf = new Map<string, string[]>();
    for (const initiative of all) {
      if (initiative.parentId === undefined) continue;
      childrenOf.set(initiative.parentId, [...(childrenOf.get(initiative.parentId) ?? []), initiative.id]);
    }
    const scope: string[] = [];
    const seen = new Set<string>();
    const queue = [rootId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      scope.push(current);
      queue.push(...(childrenOf.get(current) ?? []));
    }
    return scope;
  }

  async update(
    tenant: string,
    id: string,
    fields: InitiativeEditInput,
    actor: InitiativeActor,
  ): Promise<InitiativeRecord> {
    const record = await this.get(tenant, id);
    // Re-parenting is checked against the LIVE tree, not the record: the illegal move is not "my new parent is
    // me" (the aggregate catches that) but "my new parent is one of my own descendants", which would make the
    // readiness walk loop forever and the umbrella unanswerable.
    if (fields.parentId !== undefined && fields.parentId !== null) {
      await this.get(tenant, fields.parentId);
      const descendants = await this.subtreeIds(tenant, id);
      if (descendants.includes(fields.parentId))
        throw new ConflictError(
          "CONFLICT",
          { initiative: id, parent: fields.parentId },
          "That initiative sits under this one — moving it there would make the tree circular.",
        );
    }
    return this.applyTransition(record, Initiative.from(record).update(fields, actor.subject, this.now()));
  }

  // Posting an update on the goal — the one judgment a human authors here. The initiative keeps the latest
  // health (so a row shows it without reading the timeline) and the update itself is what a reader goes to.
  async postUpdate(
    tenant: string,
    id: string,
    input: { health: TrackerHealth; body: string },
    actor: InitiativeActor,
  ): Promise<InitiativeUpdateRecord> {
    if (!this.deps.updates)
      throw new NotFoundError("NOT_FOUND", { initiative: id }, "initiative updates are not configured.");
    const record = await this.get(tenant, id);
    const { transition, record: update } = Initiative.from(record).postUpdate(
      { id: this.newId(), health: input.health, body: input.body },
      actor.subject,
      this.now(),
    );
    // The update is written first: a posted update with no health bump is recoverable (the next read shows the
    // timeline), where a health bump with no update would be a colour nobody can explain.
    await this.deps.updates.create(update);
    await this.applyTransition(record, transition);
    return update;
  }

  async listUpdates(tenant: string, id: string, limit?: number): Promise<InitiativeUpdateRecord[]> {
    if (!this.deps.updates) return [];
    await this.get(tenant, id); // 404 for another workspace's initiative before serving its timeline
    return this.deps.updates.list(tenant, id, limit);
  }

  async setStatus(
    tenant: string,
    id: string,
    input: { status: InitiativeStatus; force?: boolean },
    actor: InitiativeActor,
  ): Promise<InitiativeRecord> {
    const record = await this.get(tenant, id);
    const { openIssues } = await this.readiness(tenant, id);
    const transition = Initiative.from(record).setStatus(
      { to: input.status, openIssues, ...(input.force !== undefined ? { force: input.force } : {}) },
      actor.subject,
      this.now(),
    );
    return this.applyTransition(record, transition);
  }

  async remove(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const record = await this.get(tenant, id);
    if (record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "initiatives:delete" },
        "You are not allowed to delete this initiative (creator or workspace admin only).",
      );
    const projects = await this.deps.projects.list(tenant, { initiativeId: id, limit: 1 });
    if (projects.length > 0)
      throw new ConflictError(
        "CONFLICT",
        { initiative: id },
        "This initiative still holds projects — move them out first.",
      );
    // Same reason a team with sub-teams cannot be deleted: the children would point at an id that resolves to
    // nothing, and where they should go instead is the member's decision.
    const children = (await this.deps.store.list(tenant)).filter((initiative) => initiative.parentId === id);
    if (children.length > 0)
      throw new ConflictError(
        "CONFLICT",
        { initiative: id, children: children.length },
        `This initiative still has ${children.length} sub-initiative(s) — move or delete them first.`,
      );
    await this.deps.store.remove(tenant, id);
  }

  private async applyTransition(
    current: InitiativeRecord,
    transition: InitiativeTransition,
  ): Promise<InitiativeRecord> {
    const stamped = stampFacts(current.tenant, transition.facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.store.update(
      current.tenant,
      current.id,
      transition.patch,
      stamped.map((s) => s.record),
    );
    if (!updated) throw new NotFoundError("NOT_FOUND", { id: current.id }, `initiative '${current.id}' not found.`);
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated;
  }
}
