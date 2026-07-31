import {
  BadRequestError,
  ForbiddenError,
  type IssueGithubSync,
  type IssueLinkType,
  type IssueRecord,
  type IssueStatus,
  type IssueStatusCause,
  NotFoundError,
  type ScorecardRecord,
} from "@everdict/contracts";
import { Issue, type IssueEditInput, type IssueTransition, type NewIssueLinkInput } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { IssueListFilter, IssueStore } from "../ports/issue-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";

// The tracker's issue use-cases (docs/tracker.md). Every mutation funnels through applyTransition — the ONE
// choke point where a domain transition becomes stamped facts + a same-tx outbox write (+ the GitHub push in
// P1). HTTP, MCP, and the regression watch all arrive here, so no transport can produce a fact-less transition.

export interface IssueAgentAttribution {
  agentId?: string;
  conversationId?: string;
}

export interface IssueActor {
  subject: string;
  isAdmin?: boolean;
  agent?: IssueAgentAttribution;
}

export interface CreateIssueInput {
  tenant: string;
  createdBy: string;
  title: string;
  description?: string;
  status?: IssueStatus;
  projectId?: string;
  assignee?: string;
  labels?: string[];
  links?: NewIssueLinkInput[];
  agent?: IssueAgentAttribution;
}

export interface SetIssueStatusInput {
  status: IssueStatus;
  resolution?: { scorecardId?: string; note?: string };
  cause?: IssueStatusCause;
}

// The GitHub half is composed, not inherited (P1): the service owns the transition, the collaborator owns the
// remote call. Absent (P0, or no App installed) = the local tracker works exactly the same, just without sync.
export interface IssueGithubPusher {
  pushStatus(record: IssueRecord, actor: IssueActor): Promise<void>;
}

export interface IssueServiceDeps {
  store: IssueStore;
  // Evidence validation only — `resolution.scorecardId` must exist in this workspace. Plain links stay
  // unvalidated pointers (platform-event subject semantics).
  scorecards?: ScorecardStore;
  events?: PlatformEventEmitter;
  github?: IssueGithubPusher;
  newId?: () => string;
  now?: () => string;
}

const EVALUATION_HISTORY_LIMIT = 100;

function causedByOf(agent: IssueAgentAttribution | undefined): string | undefined {
  if (!agent?.agentId) return undefined;
  return `agent:${agent.agentId}:${agent.conversationId ?? "unknown"}`;
}

export class IssueService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: IssueServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateIssueInput): Promise<IssueRecord> {
    const record = Issue.newIssue({
      id: this.newId(),
      tenant: input.tenant,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      ...(input.links !== undefined ? { links: input.links } : {}),
      ...(input.agent?.agentId !== undefined || input.agent?.conversationId !== undefined
        ? {
            origin: {
              ...(input.agent.agentId !== undefined ? { agentId: input.agent.agentId } : {}),
              ...(input.agent.conversationId !== undefined ? { conversationId: input.agent.conversationId } : {}),
            },
          }
        : {}),
      createdBy: input.createdBy,
      now: this.now(),
    });
    return this.persistNew(record, input.agent);
  }

  // Import shares create's persistence path so a GitHub copy is a first-class issue from birth (same facts,
  // same history shape) — only the record assembly differs, and that lives in the domain.
  async createImported(record: IssueRecord, agent?: IssueAgentAttribution): Promise<IssueRecord> {
    return this.persistNew(record, agent);
  }

  list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    return this.deps.store.list(tenant, filter);
  }

  async get(tenant: string, id: string): Promise<IssueRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `issue '${id}' not found.`);
    return record;
  }

  async update(tenant: string, id: string, fields: IssueEditInput, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, id);
    return this.applyTransition(record, Issue.from(record).update(fields, actor.subject, this.now()), actor);
  }

  // The one status entry point: it routes to the domain transition that fits the current state, so callers
  // (routes, MCP tools, the regression watch) never have to know whether a move is a resolve or a reopen.
  async setStatus(tenant: string, id: string, input: SetIssueStatusInput, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, id);
    const issue = Issue.from(record);
    const now = this.now();
    const cause = input.cause ?? "manual";
    let transition: IssueTransition;
    if (input.status === "done") {
      const resolution = input.resolution ?? {};
      if (resolution.scorecardId !== undefined) await this.assertScorecard(tenant, resolution.scorecardId);
      transition = issue.resolve(resolution, actor.subject, now, cause);
    } else if (record.status === "done" || record.status === "cancelled") {
      transition = issue.reopen(
        {
          to: input.status,
          cause,
          ...(input.resolution?.scorecardId !== undefined ? { scorecardId: input.resolution.scorecardId } : {}),
          ...(input.resolution?.note !== undefined ? { note: input.resolution.note } : {}),
        },
        actor.subject,
        now,
      );
    } else {
      transition = issue.setStatus(input.status, actor.subject, now, { cause });
    }
    return this.applyTransition(record, transition, actor);
  }

  async link(tenant: string, id: string, input: NewIssueLinkInput, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, id);
    return this.applyTransition(record, Issue.from(record).link(input, actor.subject, this.now()), actor);
  }

  async unlink(
    tenant: string,
    id: string,
    type: IssueLinkType,
    linkId: string,
    actor: IssueActor,
  ): Promise<IssueRecord> {
    const record = await this.get(tenant, id);
    return this.applyTransition(record, Issue.from(record).unlink(type, linkId, actor.subject, this.now()), actor);
  }

  async setGithubSync(tenant: string, id: string, sync: IssueGithubSync, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, id);
    return this.applyTransition(record, Issue.from(record).setGithubSync(sync, actor.subject, this.now()), actor);
  }

  async detachGithub(tenant: string, id: string, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, id);
    return this.applyTransition(record, Issue.from(record).detachGithub(actor.subject, this.now()), actor);
  }

  // The issue's EVALUATION HISTORY — what actually answers "how was this verified, and when did it stop
  // holding". Explicit scorecard links are the pinned evidence; the dataset/harness links widen it to every
  // batch that exercised the capabilities this issue watches, which is where a regression first shows up.
  async evaluationHistory(tenant: string, id: string): Promise<{ scorecards: ScorecardRecord[]; linked: string[] }> {
    const record = await this.get(tenant, id);
    const scorecards = this.deps.scorecards;
    if (!scorecards) return { scorecards: [], linked: [] };
    const linked = record.links.filter((link) => link.type === "scorecard").map((link) => link.id);
    const byId = new Map<string, ScorecardRecord>();
    for (const scorecardId of linked) {
      const found = await scorecards.get(scorecardId);
      if (found && found.tenant === tenant) byId.set(found.id, found);
    }
    // Derived rows come from the store's own filters (the SQL narrows; we never scan the workspace here).
    for (const link of record.links) {
      if (link.type !== "dataset" && link.type !== "harness") continue;
      const filter = link.type === "dataset" ? { dataset: link.id } : { harness: link.id };
      for (const found of await scorecards.list(tenant, filter)) byId.set(found.id, found);
    }
    const ordered = [...byId.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, EVALUATION_HISTORY_LIMIT);
    return { scorecards: ordered, linked };
  }

  async remove(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const record = await this.get(tenant, id);
    if (record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "issues:delete" },
        "You are not allowed to delete this issue (creator or workspace admin only).",
      );
    await this.deps.store.remove(tenant, id);
  }

  private async persistNew(record: IssueRecord, agent: IssueAgentAttribution | undefined): Promise<IssueRecord> {
    const causedBy = causedByOf(agent);
    const facts = Issue.creationFacts(record).map((fact) => ({
      ...fact,
      ...(causedBy !== undefined ? { causedBy } : {}),
    }));
    const stamped = stampFacts(record.tenant, facts, { newId: this.newId, now: this.now });
    await this.deps.store.create(
      record,
      stamped.map((s) => s.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return record;
  }

  // Stamp → persist (state + facts in one transaction) → nudge the live consumers → push to GitHub. The push
  // is fire-and-forget by contract: the local transition is already committed, and a remote failure is recorded
  // on the record (github.lastError) rather than thrown at whoever moved the issue.
  private async applyTransition(
    current: IssueRecord,
    transition: IssueTransition,
    actor: IssueActor,
  ): Promise<IssueRecord> {
    const causedBy = causedByOf(actor.agent);
    const facts = transition.facts.map((fact) => ({
      ...fact,
      ...(causedBy !== undefined ? { causedBy } : {}),
    }));
    const stamped = stampFacts(current.tenant, facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.store.update(
      current.tenant,
      current.id,
      transition.patch,
      stamped.map((s) => s.record),
    );
    if (!updated) throw new NotFoundError("NOT_FOUND", { id: current.id }, `issue '${current.id}' not found.`);
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    if (transition.patch.status !== undefined && updated.github?.sync.push === true)
      void this.deps.github?.pushStatus(updated, actor).catch(() => {});
    return updated;
  }

  private async assertScorecard(tenant: string, scorecardId: string): Promise<void> {
    const scorecards = this.deps.scorecards;
    if (!scorecards) return;
    const found = await scorecards.get(scorecardId);
    if (!found || found.tenant !== tenant)
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: scorecardId },
        `Scorecard '${scorecardId}' was not found in this workspace.`,
      );
  }
}
