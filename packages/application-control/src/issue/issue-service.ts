import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type IssueGithubSync,
  type IssueGroupBy,
  type IssueGroupCount,
  type IssueLinkType,
  type IssuePage,
  type IssuePriority,
  type IssueRecord,
  type IssueStatus,
  type IssueStatusCause,
  NotFoundError,
  type ScorecardRecord,
  parseIssueIdentifier,
} from "@everdict/contracts";
import { Issue, type IssueEditInput, type IssueTransition, type NewIssueLinkInput } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { CommentStore } from "../ports/comment-store.js";
import type { IssueListFilter, IssuePageFilter, IssueStore } from "../ports/issue-store.js";
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
  // File it into the team's triage inbox instead of straight into the workflow — what an import or an agent
  // does when the team asked for a queue in front of it.
  priority?: IssuePriority;
  estimate?: number;
  dueDate?: string;
  // The issue this one breaks out of — a sub-issue is an ordinary issue with a parent, not a nested record.
  parentId?: string;
  milestoneId?: string;
  projectId?: string;
  assignee?: string;
  // Registry ids — the caller (route/MCP/import) resolved any names first.
  labelIds?: string[];
  links?: NewIssueLinkInput[];
  agent?: IssueAgentAttribution;
}

export interface SetIssueStatusInput {
  status: IssueStatus;
  // Which board column the move landed in, when the caller moved by column. Validated against the issue's own
  // team, and its canonical status wins over `status` — the column IS the status, so a body that disagreed
  // with itself would otherwise silently pick one.
  stateId?: string;
  resolution?: { scorecardId?: string; note?: string };
  cause?: IssueStatusCause;
}

// The GitHub half is composed, not inherited (P1): the service owns the transition, the collaborator owns the
// remote call. Absent (P0, or no App installed) = the local tracker works exactly the same, just without sync.
export interface IssueGithubPusher {
  pushStatus(record: IssueRecord, actor: IssueActor): Promise<void>;
}

// Composed the same way as the GitHub pusher: this service owns the issue transition, the collaborator owns
// the identifier sequence. `WorkspaceService` satisfies it structurally, so the two stay peers instead of one
// reaching into the other.
//
// The sequence used to belong to a TEAM — `ENG-12` said whose list the issue was on. With the workspace as the
// only boundary there is one counter and one prefix, so the grant is the whole answer and there is no owner
// left to resolve alongside it.
export interface IssueNumberAllocator {
  allocateForIssue(tenant: string, by: string): Promise<{ number: number; identifier: string }>;
}

// "Is this checkpoint one of that project's" — the only question an issue asks about a milestone. Composed like
// the cycle resolver; absent = milestones are not validated in this deployment.
export interface IssueStateResolver {
  get(tenant: string, id: string): Promise<{ id: string; status: IssueStatus } | undefined>;
}

// "Does this project exist, whose is it, and what checkpoints does it have" — composed like the cycle resolver;
// absent = projects are not composed in this deployment and the field is simply not validated. `ProjectStore`
// satisfies it structurally, so the two stay peers instead of one service reaching into the other.
export interface IssueProjectResolver {
  get(tenant: string, projectId: string): Promise<{ milestones: readonly { id: string }[] } | undefined>;
}

export interface IssueServiceDeps {
  store: IssueStore;
  // Required: an issue cannot exist without an owning team, so there is no degraded mode to fall back to.
  numbers: IssueNumberAllocator;
  // Evidence validation only — `resolution.scorecardId` must exist in this workspace. Plain links stay
  // unvalidated pointers (platform-event subject semantics).
  scorecards?: ScorecardStore;
  // Read-only, and only for the LIST: a row shows how much conversation is on an issue. Injected as the store
  // rather than reached for through CommentService — a peer service edge is exactly what the layering forbids,
  // and all this needs is a count. Absent = rows carry no `commentCount` at all (see the schema: absent is
  // "nobody counted", which is the truth when nothing is wired to count).
  comments?: CommentStore;
  // "Does this cycle exist, and whose is it" — the one question an issue asks about an iteration. Absent =
  // cycles are not composed in this deployment, and the field is simply not validated.
  projects?: IssueProjectResolver;
  // "Which column is this, and whose board is it on" — the only question an issue asks about a workflow state.
  states?: IssueStateResolver;
  events?: PlatformEventEmitter;
  github?: IssueGithubPusher;
  newId?: () => string;
  now?: () => string;
}

const EVALUATION_HISTORY_LIMIT = 100;

// The comment store's key for an issue thread — the same string the detail page's CommentsSection posts under
// (`COMMENT_RESOURCE_TYPES`). Named here so the list's count and the thread itself can never key differently.
const ISSUE_COMMENT_RESOURCE = "issue";

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
    // A parent has to exist in this workspace before it can be one — the child's whole meaning is the link.
    // What is STORED is the resolved id, never what the caller spelled: `get` takes the name a team cites
    // (`ENG-12`) just as readily as the uuid, and the sub-issue query keys on the id — so filing by identifier
    // used to mint a child that its own parent's detail could never list. Re-parenting already resolved.
    const parent = input.parentId === undefined ? undefined : await this.get(input.tenant, input.parentId);
    const grant = await this.deps.numbers.allocateForIssue(input.tenant, input.createdBy);
    if (input.projectId !== undefined) await this.assertProjectExists(input.tenant, input.projectId);
    const record = Issue.newIssue({
      id: this.newId(),
      tenant: input.tenant,
      number: grant.number,
      identifier: grant.identifier,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...(parent !== undefined ? { parentId: parent.id } : {}),
      ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
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
    // The record arrives assembled, so the project edge is checked HERE — an import that files a batch into a
    // project the destination team is not on would otherwise be the one way into the state every other path
    // refuses, and it is the path that files the most issues at once.
    if (record.projectId !== undefined) await this.assertProjectExists(record.tenant, record.projectId);
    return this.persistNew(record, agent);
  }

  list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    return this.deps.store.list(tenant, filter);
  }

  // What the LIST transports serve: one page of the projection (docs/tracker.md). Whole records stay on `list`
  // for the callers that need them — the rollups, the regression watch, the GitHub sync.
  //
  // The comment totals are attached here because they live in another store, and they cost exactly ONE extra
  // query for the whole page — never one per row, which is the shape this list was rebuilt to eliminate.
  async listSummaries(tenant: string, filter?: IssuePageFilter): Promise<IssuePage> {
    const page = await this.deps.store.listSummaries(tenant, filter);
    const comments = this.deps.comments;
    if (!comments || page.items.length === 0) return page;
    const counts = await comments.countByResource(
      tenant,
      ISSUE_COMMENT_RESOURCE,
      page.items.map((item) => item.id),
    );
    const byId = new Map(counts.map((row) => [row.resourceId, row.count]));
    // An issue absent from the aggregate has no comments — a real zero, not a missing value: the row WAS
    // counted, the count is nought.
    return { ...page, items: page.items.map((item) => ({ ...item, commentCount: byId.get(item.id) ?? 0 })) };
  }

  // How many issues each group holds under the SAME filter the list is drawn with — what a grouped screen's
  // headers show. It stays a store aggregate rather than something counted off the page: a grouped list holds
  // one page PER group, so counting what it received would only ever report the page size back to itself.
  countByGroup(tenant: string, groupBy: IssueGroupBy, filter?: IssueListFilter): Promise<IssueGroupCount[]> {
    return this.deps.store.countByGroup(tenant, groupBy, filter);
  }

  // An issue is addressed by its id OR by the identifier its team minted (`ENG-12`) — the name that appears in
  // URLs, pull requests and chat. Resolving here rather than per transport means every caller (HTTP, MCP, the
  // regression watch) accepts both without a second lookup path, and every mutation below routes through it.
  // An identifier-shaped ref is read off the identifier index FIRST and falls back to the id, so the two
  // namespaces cannot shadow each other even where an id happens to read like a name; a ref that cannot be an
  // identifier costs exactly one lookup, as before.
  async get(tenant: string, ref: string): Promise<IssueRecord> {
    const identifier = parseIssueIdentifier(ref);
    const record =
      identifier !== undefined
        ? ((await this.deps.store.getByIdentifier(tenant, identifier)) ?? (await this.deps.store.get(tenant, ref)))
        : await this.deps.store.get(tenant, ref);
    if (!record) throw new NotFoundError("NOT_FOUND", { id: ref }, `issue '${ref}' not found.`);
    return record;
  }

  async update(tenant: string, id: string, fields: IssueEditInput, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, id);
    // The aggregate refuses "my parent is me"; only the live tree can refuse "my parent is my own descendant",
    // which is the move that would make the sub-issue walk circular. The parent is resolved through `get`, so a
    // caller may name it by identifier (`ENG-12`) exactly as they do everywhere else — and what gets stored is
    // always the id that resolution produced.
    let edits = fields;
    if (fields.parentId !== undefined && fields.parentId !== null) {
      const parent = await this.get(tenant, fields.parentId);
      edits = { ...fields, parentId: parent.id };
      if (await this.isDescendant(tenant, parent.id, record.id))
        throw new ConflictError(
          "CONFLICT",
          { issue: record.id, parent: parent.id },
          "That issue is a sub-issue of this one — making it the parent would close the loop.",
        );
    }
    // A cycle belongs to a team, so an issue can only be pulled into one of ITS team's iterations — otherwise
    // the issue sits on a board it can never appear on, which is work made invisible rather than planned.
    // (A re-address used to be `move`; with one workspace there is nowhere to move to.)
    // of a rename, so the issue's team here is the one it already has.)
    if (fields.projectId !== undefined && fields.projectId !== null)
      await this.assertProjectExists(tenant, fields.projectId);
    // A checkpoint belongs to a project, so an issue can only sit under one of ITS project's — the same reason
    // a cycle has to be its team's. `projectId` may be changing in the same edit, so the check reads whichever
    // project the issue will end up in.
    if (fields.milestoneId !== undefined && fields.milestoneId !== null) {
      const projectId =
        fields.projectId !== undefined && fields.projectId !== null ? fields.projectId : record.projectId;
      await this.assertMilestoneOfProject(tenant, fields.milestoneId, projectId);
    }
    return this.applyTransition(record, Issue.from(record).update(edits, actor.subject, this.now()), actor);
  }

  private async resolveState(
    tenant: string,
    stateId: string,
  ): Promise<{ id: string; status: IssueStatus } | undefined> {
    if (!this.deps.states) return undefined; // the board is not composed — the caller's canonical status stands
    const state = await this.deps.states.get(tenant, stateId);
    if (!state) throw new NotFoundError("NOT_FOUND", { state: stateId }, `workflow state '${stateId}' not found.`);
    return { id: state.id, status: state.status };
  }

  private async assertMilestoneOfProject(
    tenant: string,
    milestoneId: string,
    projectId: string | undefined,
  ): Promise<void> {
    if (!this.deps.projects) return; // projects not composed — nothing to validate against
    if (projectId === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { milestone: milestoneId },
        "A milestone is a checkpoint inside a project — put the issue in the project first.",
      );
    const project = await this.deps.projects.get(tenant, projectId);
    if (!project?.milestones.some((m) => m.id === milestoneId))
      throw new BadRequestError(
        "BAD_REQUEST",
        { milestone: milestoneId, project: projectId },
        "That milestone is not on this issue's project.",
      );
  }

  // "Does this project exist" — all an issue asks about a project now that the workspace is the only owner.
  // It used to also ask whose it was: a project named its teams and an issue could only join one its OWN team
  // was on. With one workspace both sides of that comparison are the same value, so the question is existence.
  private async assertProjectExists(tenant: string, projectId: string): Promise<void> {
    if (!this.deps.projects) return;
    const project = await this.deps.projects.get(tenant, projectId);
    if (!project) throw new NotFoundError("NOT_FOUND", { project: projectId }, `project '${projectId}' not found.`);
  }

  // Walks UP from `candidate` looking for `ancestor`. Bounded by a visited set, so even a cycle written by an
  // older build terminates instead of hanging the request.
  private async isDescendant(tenant: string, candidate: string, ancestor: string): Promise<boolean> {
    const seen = new Set<string>();
    let current: string | undefined = candidate;
    while (current !== undefined && !seen.has(current)) {
      if (current === ancestor) return true;
      seen.add(current);
      const record: IssueRecord | undefined = await this.deps.store.get(tenant, current);
      current = record?.parentId;
    }
    return false;
  }

  // The one status entry point: it routes to the domain transition that fits the current state, so callers
  // (routes, MCP tools, the regression watch) never have to know whether a move is a resolve or a reopen.
  async setStatus(tenant: string, id: string, input: SetIssueStatusInput, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, id);
    const issue = Issue.from(record);
    const now = this.now();
    const cause = input.cause ?? "manual";
    // Moving by column: the column names the canonical status, so it decides.
    const state = input.stateId === undefined ? undefined : await this.resolveState(tenant, input.stateId);
    const to = state?.status ?? input.status;
    let transition: IssueTransition;
    if (to === "done") {
      const resolution = input.resolution ?? {};
      if (resolution.scorecardId !== undefined) await this.assertScorecard(tenant, resolution.scorecardId);
      transition = issue.resolve(resolution, actor.subject, now, cause);
    } else if (record.status === "done" || record.status === "cancelled") {
      transition = issue.reopen(
        {
          to,
          cause,
          ...(input.resolution?.scorecardId !== undefined ? { scorecardId: input.resolution.scorecardId } : {}),
          ...(input.resolution?.note !== undefined ? { note: input.resolution.note } : {}),
        },
        actor.subject,
        now,
      );
    } else {
      transition = issue.setStatus(to, actor.subject, now, {
        cause,
        ...(state !== undefined ? { stateId: state.id } : {}),
      });
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

  async remove(tenant: string, ref: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const record = await this.get(tenant, ref);
    if (record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id: record.id, action: "issues:delete" },
        "You are not allowed to delete this issue (creator or workspace admin only).",
      );
    // Deleting a parent would strand its sub-issues pointing at an id that resolves to nothing. Where they
    // should go instead (up a level, under a sibling, deleted too) is the member's decision, so it is refused
    // with the count rather than guessed at — the same gate a project with issues has.
    const children = await this.deps.store.list(tenant, { parentId: record.id, limit: 1 });
    if (children.length > 0)
      throw new ConflictError(
        "CONFLICT",
        { issue: record.id },
        "This issue still has sub-issues — move or delete them first.",
      );
    await this.deps.store.remove(tenant, record.id); // the resolved id — the ref may have been an identifier
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
