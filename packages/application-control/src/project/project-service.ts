import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type ProjectRecord,
  type ProjectStatus,
} from "@everdict/contracts";
import type { ProjectDetailResponse } from "@everdict/contracts/wire";
import { Project, type ProjectEditInput, type ProjectTransition, projectRollup } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ProjectListFilter, ProjectStore } from "../ports/project-store.js";

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
  initiativeId?: string;
  targetDate?: string;
}

export interface ProjectServiceDeps {
  store: ProjectStore;
  issues: IssueStore;
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
    const record = Project.newProject({
      id: this.newId(),
      tenant: input.tenant,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.initiativeId !== undefined ? { initiativeId: input.initiativeId } : {}),
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

  list(tenant: string, filter?: ProjectListFilter): Promise<ProjectRecord[]> {
    return this.deps.store.list(tenant, filter);
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
    return this.applyTransition(record, Project.from(record).update(fields, actor.subject, this.now()));
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
