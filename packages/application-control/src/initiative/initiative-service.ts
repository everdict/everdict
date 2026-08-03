import {
  ConflictError,
  ForbiddenError,
  type InitiativeReadiness,
  type InitiativeRecord,
  type InitiativeStatus,
  type IssueRecord,
  NotFoundError,
} from "@everdict/contracts";
import type { InitiativeDetailResponse } from "@everdict/contracts/wire";
import { Initiative, type InitiativeEditInput, type InitiativeTransition, initiativeReadiness } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { InitiativeListFilter, InitiativeStore } from "../ports/initiative-store.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ProjectStore } from "../ports/project-store.js";

// The deployment umbrella. Its one interesting operation is completion, which is a GATE: it reads the live
// readiness across every project's issues and refuses while anything is open. Stores are injected directly
// (never peer services) so the readiness read is one fan-out, not a chain of service calls.

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
  targetDate?: string;
}

export interface InitiativeServiceDeps {
  store: InitiativeStore;
  projects: ProjectStore;
  issues: IssueStore;
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

  list(tenant: string, filter?: InitiativeListFilter): Promise<InitiativeRecord[]> {
    return this.deps.store.list(tenant, filter);
  }

  async get(tenant: string, id: string): Promise<InitiativeRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `initiative '${id}' not found.`);
    return record;
  }

  async detail(tenant: string, id: string): Promise<InitiativeDetailResponse> {
    const record = await this.get(tenant, id);
    return { ...record, readiness: await this.readiness(tenant, id) };
  }

  // The deployment verdict: every project under the umbrella — including the ones claimed by a DESCENDANT
  // initiative — each project's issues, one answer. Nesting exists so a big bet can decompose, and a parent
  // that reported "ready" while a sub-initiative was still blocked would make the decomposition a way to hide
  // work from the release gate.
  async readiness(tenant: string, id: string): Promise<InitiativeReadiness> {
    const scope = await this.subtreeIds(tenant, id);
    const projects = await this.deps.projects.list(tenant, { initiativeIds: scope });
    const issuesByProject = new Map<string, IssueRecord[]>();
    for (const project of projects)
      issuesByProject.set(project.id, await this.deps.issues.list(tenant, { projectId: project.id }));
    return initiativeReadiness(id, projects, issuesByProject);
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
