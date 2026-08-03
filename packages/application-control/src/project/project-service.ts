import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type ProjectHealth,
  type ProjectRecord,
  type ProjectStatus,
  type ProjectUpdateRecord,
} from "@everdict/contracts";
import type { ProjectDetailResponse } from "@everdict/contracts/wire";
import { Project, type ProjectEditInput, type ProjectTransition, projectRollup } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { InitiativeStore } from "../ports/initiative-store.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ProjectListFilter, ProjectStore, ProjectUpdateStore } from "../ports/project-store.js";
import type { TeamStore } from "../ports/team-store.js";

// Projects group issues under a target date. The service owns the counting (it holds the stores); the domain
// owns what the count MEANS — completing a project with open issues is refused there, not here.

export interface ProjectActor {
  subject: string;
  isAdmin?: boolean;
}

export interface CreateProjectInput {
  tenant: string;
  createdBy: string;
  name: string;
  description?: string;
  // Both many-to-many. Absent teams fall back to the workspace's default team, the same courtesy an issue gets
  // — a project that names no team would be invisible in the one place people look for their work.
  teamIds?: string[];
  initiativeIds?: string[];
  // Who is answerable, and who is on it.
  lead?: string;
  memberIds?: string[];
  targetDate?: string;
}

export interface ProjectServiceDeps {
  store: ProjectStore;
  issues: IssueStore;
  // Read-only, and stores rather than the peer services: the project's own edges have to point at things that
  // exist in THIS workspace, and that check is a store read, not a service call (see the api-layer skill —
  // peer services never call each other).
  teams: TeamStore;
  initiatives: InitiativeStore;
  // The posted-update timeline. Absent = this deployment does not carry project updates, and the health routes
  // answer 404 — the rest of the project works unchanged.
  updates?: ProjectUpdateStore;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

export class ProjectService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateProjectInput): Promise<ProjectRecord> {
    const teamIds = await this.resolveTeams(input.tenant, input.teamIds);
    await this.assertInitiativesExist(input.tenant, input.initiativeIds ?? []);
    const record = Project.newProject({
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      teamIds,
      initiativeIds: input.initiativeIds ?? [],
      ...(input.lead !== undefined ? { lead: input.lead } : {}),
      ...(input.memberIds !== undefined ? { memberIds: input.memberIds } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      createdBy: input.createdBy,
      now: this.now(),
    });
    const stamped = stampFacts(record.tenant, Project.creationFacts(record), { newId: this.newId, now: this.now });
    await this.deps.store.create(
      record,
      stamped.map((s) => s.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return record;
  }

  // Both narrowings are the store's now (`team_ids`/`initiative_ids` containment). "This team's projects" used
  // to be derived from the team's ISSUES, which answered "none" for exactly as long as a project was still
  // being planned — the window where the question gets asked. A project names its teams, so it can say so
  // before a single issue exists.
  list(tenant: string, filter?: ProjectListFilter): Promise<ProjectRecord[]> {
    return this.deps.store.list(tenant, filter);
  }

  // An edge has to point at something real in THIS workspace: a project claiming a team that does not exist
  // would sit in a list nobody can open, and one claiming a stranger's initiative would leak that it exists.
  // Unknown ids are a 400 naming them, never a silent drop — a caller that mistyped one wants to hear about it.
  private async assertTeamsExist(tenant: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const known = new Set((await this.deps.teams.list(tenant)).map((team) => team.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0)
      throw new BadRequestError("BAD_REQUEST", { teamIds: unknown }, `Unknown team(s): ${unknown.join(", ")}.`);
  }

  private async assertInitiativesExist(tenant: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const known = new Set((await this.deps.initiatives.list(tenant)).map((initiative) => initiative.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { initiativeIds: unknown },
        `Unknown initiative(s): ${unknown.join(", ")}.`,
      );
  }

  // Named teams are validated; naming none lands the project on the workspace's default team, so it shows up
  // in the sidebar of the people who will work on it. A workspace with no team at all (never filed an issue)
  // simply gets an empty list — minting one is TeamService's job, not a side effect of creating a project.
  private async resolveTeams(tenant: string, teamIds: string[] | undefined): Promise<string[]> {
    if (teamIds !== undefined && teamIds.length > 0) {
      await this.assertTeamsExist(tenant, teamIds);
      return teamIds;
    }
    const fallback = await this.deps.teams.getDefault(tenant);
    return fallback ? [fallback.id] : [];
  }

  async get(tenant: string, id: string): Promise<ProjectRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `project '${id}' not found.`);
    return record;
  }

  // Detail carries the rollup; lists stay lean. Derived on read for the same reason trialSummary is: the
  // arithmetic is cheap and a stored count would need invalidating on every issue write.
  async detail(tenant: string, id: string): Promise<ProjectDetailResponse> {
    const record = await this.get(tenant, id);
    const issues = await this.deps.issues.list(tenant, { projectId: id });
    return { ...record, rollup: projectRollup(issues) };
  }

  async update(tenant: string, id: string, fields: ProjectEditInput, actor: ProjectActor): Promise<ProjectRecord> {
    const record = await this.get(tenant, id);
    // A list REPLACES what is there, so an empty array is a legal edit (detach every team) — which is why these
    // run on the value given rather than through the create path's default-team fallback.
    if (fields.teamIds !== undefined) await this.assertTeamsExist(tenant, fields.teamIds);
    if (fields.initiativeIds !== undefined) await this.assertInitiativesExist(tenant, fields.initiativeIds);
    return this.applyTransition(record, Project.from(record).update(fields, actor.subject, this.now()));
  }

  // Posting an update — the one judgment the tracker records. The project keeps the latest health (so a row
  // shows it without reading the timeline) and the update itself is the record a reader goes to.
  async postUpdate(
    tenant: string,
    id: string,
    input: { health: ProjectHealth; body: string },
    actor: ProjectActor,
  ): Promise<ProjectUpdateRecord> {
    if (!this.deps.updates)
      throw new NotFoundError("NOT_FOUND", { project: id }, "project updates are not configured.");
    const record = await this.get(tenant, id);
    const { transition, record: update } = Project.from(record).postUpdate(
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

  async listUpdates(tenant: string, id: string, limit?: number): Promise<ProjectUpdateRecord[]> {
    if (!this.deps.updates) return [];
    await this.get(tenant, id); // 404 for another workspace's project before serving its timeline
    return this.deps.updates.list(tenant, id, limit);
  }

  // Milestones — the project's own checkpoints, edited on the project itself.
  async addMilestone(
    tenant: string,
    id: string,
    input: { name: string; description?: string; targetDate?: string },
    actor: ProjectActor,
  ): Promise<ProjectRecord> {
    const record = await this.get(tenant, id);
    return this.applyTransition(
      record,
      Project.from(record).addMilestone(
        {
          id: this.newId(),
          name: input.name,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
        },
        actor.subject,
        this.now(),
      ),
    );
  }

  // Removing one detaches every issue that pointed at it in the same operation — a `milestoneId` that resolves
  // to nothing is exactly the dangling reference the label registry refuses to allow.
  async removeMilestone(tenant: string, id: string, milestoneId: string, actor: ProjectActor): Promise<ProjectRecord> {
    const record = await this.get(tenant, id);
    const updated = await this.applyTransition(
      record,
      Project.from(record).removeMilestone(milestoneId, actor.subject, this.now()),
    );
    const orphaned = await this.deps.issues.list(tenant, { milestoneId });
    for (const issue of orphaned)
      await this.deps.issues.update(tenant, issue.id, { milestoneId: undefined, updatedAt: this.now() });
    return updated;
  }

  async setStatus(
    tenant: string,
    id: string,
    input: { status: ProjectStatus; force?: boolean },
    actor: ProjectActor,
  ): Promise<ProjectRecord> {
    const record = await this.get(tenant, id);
    const issues = await this.deps.issues.list(tenant, { projectId: id });
    const transition = Project.from(record).setStatus(
      {
        to: input.status,
        openIssues: projectRollup(issues).open,
        ...(input.force !== undefined ? { force: input.force } : {}),
      },
      actor.subject,
      this.now(),
    );
    return this.applyTransition(record, transition);
  }

  // Deleting a project that still holds issues would orphan them, so it is refused with the count — the web
  // offers to reassign. (Issues themselves are hard-deleted; a project is a container.)
  async remove(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const record = await this.get(tenant, id);
    if (record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "projects:delete" },
        "You are not allowed to delete this project (creator or workspace admin only).",
      );
    const issues = await this.deps.issues.list(tenant, { projectId: id, limit: 1 });
    if (issues.length > 0)
      throw new ConflictError(
        "CONFLICT",
        { project: id },
        "This project still holds issues — move them to another project first.",
      );
    await this.deps.store.remove(tenant, id);
  }

  private async applyTransition(current: ProjectRecord, transition: ProjectTransition): Promise<ProjectRecord> {
    const stamped = stampFacts(current.tenant, transition.facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.store.update(
      current.tenant,
      current.id,
      transition.patch,
      stamped.map((s) => s.record),
    );
    if (!updated) throw new NotFoundError("NOT_FOUND", { id: current.id }, `project '${current.id}' not found.`);
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated;
  }
}
