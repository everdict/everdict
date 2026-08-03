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
  // Absent = the workspace's default team. Teams exist so an issue has an owner; making the caller name one
  // every time would just push that decision onto every transport for no gain.
  teamId?: string;
  title: string;
  description?: string;
  status?: IssueStatus;
  // File it into the team's triage inbox instead of straight into the workflow — what an import or an agent
  // does when the team asked for a queue in front of it.
  inTriage?: boolean;
  priority?: IssuePriority;
  estimate?: number;
  dueDate?: string;
  // The issue this one breaks out of — a sub-issue is an ordinary issue with a parent, not a nested record.
  parentId?: string;
  // The team iteration it is pulled into, and the project checkpoint it belongs to.
  cycleId?: string;
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
// team resolution and the identifier sequence. TeamService satisfies it structurally, so the two stay peers
// instead of one reaching into the other.
export interface IssueTeamAllocator {
  allocateForIssue(
    tenant: string,
    teamId: string | undefined,
    by: string,
  ): Promise<{ team: { id: string }; grant: { number: number; identifier: string } }>;
}

// The cycle half is composed like the GitHub and team collaborators: this service owns the issue transition,
// the seam answers "does this cycle exist, and whose is it". Absent = cycles are simply not validated, which is
// the P0 shape (a deployment without the cycle service still tracks issues).
export interface IssueCycleResolver {
  get(tenant: string, id: string): Promise<{ id: string; teamId: string } | undefined>;
}

// "Is this checkpoint one of that project's" — the only question an issue asks about a milestone. Composed like
// the cycle resolver; absent = milestones are not validated in this deployment.
export interface IssueStateResolver {
  get(tenant: string, id: string): Promise<{ id: string; teamId: string; status: IssueStatus } | undefined>;
}

// "Does this project exist, whose is it, and what checkpoints does it have" — composed like the cycle resolver;
// absent = projects are not composed in this deployment and the field is simply not validated. `ProjectStore`
// satisfies it structurally, so the two stay peers instead of one service reaching into the other.
export interface IssueProjectResolver {
  get(
    tenant: string,
    projectId: string,
  ): Promise<{ teamIds: readonly string[]; milestones: readonly { id: string }[] } | undefined>;
}

export interface IssueServiceDeps {
  store: IssueStore;
  // Required: an issue cannot exist without an owning team, so there is no degraded mode to fall back to.
  teams: IssueTeamAllocator;
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
  cycles?: IssueCycleResolver;
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
    if (input.parentId !== undefined) await this.get(input.tenant, input.parentId);
    const { team, grant } = await this.deps.teams.allocateForIssue(input.tenant, input.teamId, input.createdBy);
    if (input.cycleId !== undefined) await this.assertCycleOfTeam(input.tenant, input.cycleId, team.id);
    if (input.projectId !== undefined) await this.assertProjectOfTeam(input.tenant, input.projectId, team.id);
    const record = Issue.newIssue({
      id: this.newId(),
      tenant: input.tenant,
      teamId: team.id,
      number: grant.number,
      identifier: grant.identifier,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
      ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
      ...(input.inTriage !== undefined ? { inTriage: input.inTriage } : {}),
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
    if (record.projectId !== undefined) await this.assertProjectOfTeam(record.tenant, record.projectId, record.teamId);
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
    if (fields.cycleId !== undefined && fields.cycleId !== null)
      await this.assertCycleOfTeam(tenant, fields.cycleId, record.teamId);
    // A project names its teams, so an issue can only join one its own team is on — the same rule as the cycle,
    // one level up. (`teamId` is deliberately absent from an edit: a re-address is `move`, never a side effect
    // of a rename, so the issue's team here is the one it already has.)
    if (fields.projectId !== undefined && fields.projectId !== null)
      await this.assertProjectOfTeam(tenant, fields.projectId, record.teamId);
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
    teamId: string,
  ): Promise<{ id: string; status: IssueStatus } | undefined> {
    if (!this.deps.states) return undefined; // the board is not composed — the caller's canonical status stands
    const state = await this.deps.states.get(tenant, stateId);
    if (!state) throw new NotFoundError("NOT_FOUND", { state: stateId }, `workflow state '${stateId}' not found.`);
    if (state.teamId !== teamId)
      throw new BadRequestError(
        "BAD_REQUEST",
        { state: stateId, team: teamId },
        "That column belongs to another team's board.",
      );
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

  // A project names the teams working it, so an issue can only join one its OWN team is on — the same rule a
  // cycle has, and for the same reason: a project the issue's team is not part of is a list the issue can never
  // be seen in from the team that owns it. This is also what makes "this team's projects" a real answer rather
  // than a hint: the picker a member is offered and the set the control plane accepts are the same set.
  private async assertProjectOfTeam(tenant: string, projectId: string, teamId: string): Promise<void> {
    if (!this.deps.projects) return; // projects not composed — nothing to validate against
    const project = await this.deps.projects.get(tenant, projectId);
    if (!project) throw new NotFoundError("NOT_FOUND", { project: projectId }, `project '${projectId}' not found.`);
    if (!project.teamIds.includes(teamId))
      throw new BadRequestError(
        "BAD_REQUEST",
        { project: projectId, team: teamId },
        "That project is not one of this team's — add the team to the project first, or file the issue on a team that is on it.",
      );
  }

  // The same edge read as a question instead of a guard — a move asks it, and an unanswerable one keeps the
  // project: projects that are not composed (or a pointer that no longer resolves) are not a reason for a team
  // move to quietly empty a field.
  private async projectHoldsTeam(tenant: string, projectId: string, teamId: string): Promise<boolean> {
    if (!this.deps.projects) return true;
    const project = await this.deps.projects.get(tenant, projectId);
    return project === undefined || project.teamIds.includes(teamId);
  }

  private async assertCycleOfTeam(tenant: string, cycleId: string, teamId: string): Promise<void> {
    if (!this.deps.cycles) return; // cycles not composed — nothing to validate against
    const cycle = await this.deps.cycles.get(tenant, cycleId);
    if (!cycle) throw new NotFoundError("NOT_FOUND", { cycle: cycleId }, `cycle '${cycleId}' not found.`);
    if (cycle.teamId !== teamId)
      throw new BadRequestError(
        "BAD_REQUEST",
        { cycle: cycleId, team: teamId },
        "That cycle belongs to another team — an issue can only join its own team's iterations.",
      );
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

  // Triage: accept the issue into the team's workflow, or decline it (which is a cancellation with a reason —
  // the issue stays on the record rather than vanishing, because "we said no to this" is an answer somebody
  // will look for). Both route through the same choke point as every other transition.
  async acceptTriage(tenant: string, ref: string, to: IssueStatus, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, ref);
    return this.applyTransition(record, Issue.from(record).acceptFromTriage(to, actor.subject, this.now()), actor);
  }

  async declineTriage(tenant: string, ref: string, note: string | undefined, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, ref);
    if (!record.inTriage)
      throw new ConflictError(
        "CONFLICT",
        { issue: record.id },
        "This issue is not in triage — it is already in the workflow.",
      );
    const cancelled = await this.applyTransition(
      record,
      Issue.from(record).setStatus("cancelled", actor.subject, this.now(), {
        ...(note !== undefined ? { note } : {}),
      }),
      actor,
    );
    // The flag clears with the decline: a declined issue is settled, and leaving it in the inbox would make the
    // queue grow with things nobody has to look at again.
    const cleared = await this.deps.store.update(tenant, cancelled.id, { inTriage: false, updatedAt: this.now() });
    return cleared ?? cancelled;
  }

  // Hand the issue to another team. The number comes from the DESTINATION's counter through the same allocator
  // filing uses, so a moved issue is numbered exactly like one filed there — and the old identifier keeps
  // resolving (the record remembers it), which is what makes re-minting safe for links already in the wild.
  async move(tenant: string, ref: string, teamId: string, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, ref);
    // The aggregate refuses a no-op move too; this earlier copy of the guard exists so the refusal does not
    // burn a number off the destination's counter on the way to being rejected.
    if (record.teamId === teamId)
      throw new ConflictError(
        "CONFLICT",
        { issue: record.id, team: teamId },
        "This issue already belongs to that team.",
      );
    const { team, grant } = await this.deps.teams.allocateForIssue(tenant, teamId, actor.subject);
    // Whether the issue keeps its project is a store question (does the project name the destination team), so
    // it is answered here and handed to the aggregate as a fact. A project spans teams, so moving INSIDE the
    // project's own set of teams keeps it; moving out of that set drops it, because an issue in a project its
    // team is not on is exactly the state every other path refuses. Asked with the RESOLVED id — the caller may
    // have named the destination by key (`PLT`), and the project's list holds ids.
    const projectHoldsTeam =
      record.projectId === undefined ? undefined : await this.projectHoldsTeam(tenant, record.projectId, team.id);
    return this.applyTransition(
      record,
      Issue.from(record).moveToTeam(
        {
          teamId: team.id,
          number: grant.number,
          identifier: grant.identifier,
          ...(projectHoldsTeam !== undefined ? { projectHoldsTeam } : {}),
        },
        actor.subject,
        this.now(),
      ),
      actor,
    );
  }

  // The one status entry point: it routes to the domain transition that fits the current state, so callers
  // (routes, MCP tools, the regression watch) never have to know whether a move is a resolve or a reopen.
  async setStatus(tenant: string, id: string, input: SetIssueStatusInput, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.get(tenant, id);
    const issue = Issue.from(record);
    const now = this.now();
    const cause = input.cause ?? "manual";
    // Moving by column: the column names the canonical status, so it decides — and it has to be one of the
    // issue's OWN team's columns, for the same reason a cycle has to be its team's.
    const state =
      input.stateId === undefined ? undefined : await this.resolveState(tenant, input.stateId, record.teamId);
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
