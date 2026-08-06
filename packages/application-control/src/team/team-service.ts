import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  type TeamMemberRecord,
  type TeamRecord,
  type TeamSummary,
  parseTeamKey,
} from "@everdict/contracts";
import { Team, type TeamEditInput, type TeamTransition, normalizeTeamKey } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { IssueStore, IssueTeamCounts } from "../ports/issue-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { IssueNumberGrant, TeamStore } from "../ports/team-store.js";

// The tracker's team use-cases (docs/tracker.md). Like IssueService, every mutation funnels through one
// applyTransition so no transport can produce a fact-less change.
//
// The load-bearing invariant is `ensureDefault`: a workspace ALWAYS has at least one team, and exactly one of
// them is the default. It is repaired lazily rather than at workspace creation, because workspaces come into
// existence through several paths (POST /workspaces, the api-key bootstrap, a dev fallback) and an invariant
// that depends on remembering to call it at each of them is not an invariant.

export interface TeamActor {
  subject: string;
  isAdmin?: boolean;
}

export interface CreateTeamInput {
  tenant: string;
  createdBy: string;
  key: string;
  name: string;
  description?: string;
  // Promote on creation, moving the flag off the incumbent. Absent = the first team in a workspace is the
  // default by necessity, every later one is not.
  isDefault?: boolean;
  // The team this one sits under. Organisational only — a sub-team owns its own issues and mints its own
  // identifiers, so nesting never changes an issue's address.
  parentId?: string;
  // A private team's work is visible only to its roster (and to workspace admins).
  isPrivate?: boolean;
  // Seed the roster (the creator is added automatically — someone who makes a team is on it).
  members?: string[];
}

// The board a team starts with. Composed rather than reached for: TeamService owns the team, the seam owns the
// states, and a deployment without a board still creates teams.
export interface TeamWorkflowSeeder {
  ensureDefaults(tenant: string, teamId: string): Promise<unknown>;
}

export interface TeamServiceDeps {
  store: TeamStore;
  // Read-only: the delete gate counts what the team still holds, and list summaries count issues per team.
  issues: IssueStore;
  workflowStates?: TeamWorkflowSeeder;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

// The auto-created team a workspace falls back to. "Core" rather than "General" because it is the team that
// owns everything nobody has split out yet, and CORE reads correctly in an identifier (CORE-12).
export const DEFAULT_TEAM_KEY = "CORE";
export const DEFAULT_TEAM_NAME = "Core";

// The workspace's counts, indexed by team — read once per request and shared by every row that needs a summary.
interface WorkspaceTeamCounts {
  issues: Map<string, IssueTeamCounts>;
  members: Map<string, number>;
}

// A team absent from either aggregate has nothing of that kind, which is a real zero rather than a missing
// value — the store returns no group for a team with no rows.
function summaryFrom(teamId: string, counts: WorkspaceTeamCounts): TeamSummary {
  const issues = counts.issues.get(teamId);
  return {
    memberCount: counts.members.get(teamId) ?? 0,
    totalIssues: issues === undefined ? 0 : issues.total,
    openIssues: issues === undefined ? 0 : issues.open,
  };
}

export class TeamService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: TeamServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // The invariant's repair point. Idempotent and safe to call on any read path: it only writes when the
  // workspace genuinely has no team.
  async ensureDefault(tenant: string, by: string): Promise<TeamRecord> {
    const existing = await this.deps.store.getDefault(tenant);
    if (existing) return existing;
    // A workspace can hold teams while none is flagged default only if a row was hand-edited; promote the
    // first one rather than minting a second CORE alongside it.
    const [orphan] = await this.deps.store.list(tenant, { limit: 1 });
    if (orphan) {
      const promoted = await this.applyTransition(orphan, Team.from(orphan).promoteToDefault(by, this.now()));
      return promoted;
    }
    const record = Team.newTeam({
      id: this.newId(),
      tenant,
      key: DEFAULT_TEAM_KEY,
      name: DEFAULT_TEAM_NAME,
      isDefault: true,
      createdBy: by,
      now: this.now(),
    });
    await this.deps.store.create(record, this.stamp(tenant, Team.creationFacts(record)));
    return record;
  }

  async create(input: CreateTeamInput): Promise<TeamRecord> {
    const key = normalizeTeamKey(input.key);
    if (await this.deps.store.getByKey(input.tenant, key))
      throw new ConflictError("CONFLICT", { key }, `A team with the key ${key} already exists in this workspace.`);
    if (input.parentId !== undefined) await this.get(input.tenant, input.parentId); // 404 if it is not ours
    // The first team in a workspace has to be the default — there would be nowhere for an unrouted issue to go.
    const teamCount = await this.deps.store.count(input.tenant);
    const isDefault = teamCount === 0 ? true : (input.isDefault ?? false);
    const now = this.now();
    const record = Team.newTeam({
      id: this.newId(),
      tenant: input.tenant,
      key,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.isPrivate !== undefined ? { isPrivate: input.isPrivate } : {}),
      isDefault,
      createdBy: input.createdBy,
      now,
    });
    if (isDefault && teamCount > 0) {
      const incumbent = await this.deps.store.getDefault(input.tenant);
      if (incumbent) await this.applyTransition(incumbent, Team.from(incumbent).demoteFromDefault(now));
    }
    await this.deps.store.create(record, this.stamp(input.tenant, Team.creationFacts(record)));
    // A team is born with a board — Linear's default six states, named and ordered. Seeded here so a team that
    // never opens its settings still has columns, and so renaming one is editing a row rather than inventing the
    // concept.
    await this.deps.workflowStates?.ensureDefaults(input.tenant, record.id);
    // Whoever creates a team is on it — a team you cannot see is not a team you meant to make.
    const roster = new Set([input.createdBy, ...(input.members ?? [])]);
    for (const subject of roster) await this.addMember(input.tenant, record.id, subject, { subject: input.createdBy });
    return (await this.deps.store.get(input.tenant, record.id)) ?? record;
  }

  // A team is addressed by its id OR by the key it stamps on every issue it mints (`ENG`) — the name that
  // appears in URLs (`/{workspace}/teams/ENG/issues`) and in conversation. Resolving here rather than per
  // transport means every caller (HTTP, MCP, the web) accepts both, and every mutation below routes through it.
  // A key-shaped ref is read off the key index FIRST and falls back to the id, so the two namespaces cannot
  // shadow each other; a ref that cannot be a key (a uuid) costs exactly one lookup, as before.
  async get(tenant: string, ref: string): Promise<TeamRecord> {
    const key = parseTeamKey(ref);
    const record =
      key !== undefined
        ? ((await this.deps.store.getByKey(tenant, key)) ?? (await this.deps.store.get(tenant, ref)))
        : await this.deps.store.get(tenant, ref);
    if (!record) throw new NotFoundError("NOT_FOUND", { team: ref }, "Team not found."); // cross-workspace reads 404, never 403
    return record;
  }

  // The id behind a ref, for a caller that holds a team-shaped URL segment and needs to hand an id to a store or
  // a sibling service. 404s on an unknown ref rather than returning it unchanged — a filter that silently keeps
  // a bad ref answers with an empty list, which reads as "this team has nothing" instead of "no such team".
  async resolveId(tenant: string, ref: string): Promise<string> {
    return (await this.get(tenant, ref)).id;
  }

  async list(tenant: string, filter?: { member?: string; limit?: number }): Promise<TeamRecord[]> {
    return this.deps.store.list(tenant, filter);
  }

  // The workspace's default team, or undefined while it has none. A pure read — unlike `ensureDefault`, which
  // creates one, and which an authorization path must never call.
  async defaultTeam(tenant: string): Promise<TeamRecord | undefined> {
    return this.deps.store.getDefault(tenant);
  }

  // Counts a list row wants — derived on read like ProjectRollup, never stored.
  //
  // Two AGGREGATES for the whole workspace, not a fetch per team. This used to list every issue of every team
  // and count the returned records: three integers per row cost a full read (and a full Zod parse) of the
  // workspace's issue table, so `GET /teams` was as expensive as `GET /issues` for a 1.6 KB answer. The counting
  // belongs where the rows are.
  // Keyed off the teams the caller asked about, so a team with neither issues nor members still reports a row of
  // zeroes rather than dropping out of its own list.
  async summaries(tenant: string, teamIds: string[]): Promise<Map<string, TeamSummary>> {
    const counts = await this.workspaceCounts(tenant);
    return new Map(teamIds.map((teamId) => [teamId, summaryFrom(teamId, counts)]));
  }

  async summary(tenant: string, teamId: string): Promise<TeamSummary> {
    return summaryFrom(teamId, await this.workspaceCounts(tenant));
  }

  private async workspaceCounts(tenant: string): Promise<WorkspaceTeamCounts> {
    const [issues, members] = await Promise.all([
      this.deps.issues.countByTeam(tenant),
      this.deps.store.countMembersByTeam(tenant),
    ]);
    return {
      issues: new Map(issues.map((row) => [row.teamId, row])),
      members: new Map(members.map((row) => [row.teamId, row.count])),
    };
  }

  async update(tenant: string, ref: string, fields: TeamEditInput, actor: TeamActor): Promise<TeamRecord> {
    const record = await this.get(tenant, ref);
    // The aggregate refuses "my parent is me"; only the live tree can refuse "my parent is my own descendant",
    // which is the move that would make the sub-team walk circular. The parent is resolved through `get`, so a
    // caller may name it by key exactly as they do everywhere else — and what gets stored is always the id.
    let edits = fields;
    if (fields.parentId !== undefined && fields.parentId !== null) {
      const parent = await this.get(tenant, fields.parentId);
      const descendants = await this.subtreeIds(tenant, record.id);
      if (descendants.includes(parent.id))
        throw new ConflictError(
          "CONFLICT",
          { team: record.id, parent: parent.id },
          "That team sits under this one — moving it there would make the tree circular.",
        );
      edits = { ...fields, parentId: parent.id };
    }
    return this.applyTransition(record, Team.from(record).update(edits, actor.subject, this.now()));
  }

  // The team plus every descendant, from one list of the workspace's teams (a workspace holds few, and a query
  // per level would cost a round trip per level for the same answer). Visited-guarded, so a cycle terminates.
  private async subtreeIds(tenant: string, rootId: string): Promise<string[]> {
    const all = await this.deps.store.list(tenant);
    const childrenOf = new Map<string, string[]>();
    for (const team of all) {
      if (team.parentId === undefined) continue;
      childrenOf.set(team.parentId, [...(childrenOf.get(team.parentId) ?? []), team.id]);
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

  // Hand the default flag over in two writes — demote the incumbent, promote the successor — so the workspace
  // is never left without a landing place for an unrouted issue.
  async makeDefault(tenant: string, id: string, actor: TeamActor): Promise<TeamRecord> {
    const record = await this.get(tenant, id);
    const now = this.now();
    const incumbent = await this.deps.store.getDefault(tenant);
    if (incumbent && incumbent.id !== record.id)
      await this.applyTransition(incumbent, Team.from(incumbent).demoteFromDefault(now));
    return this.applyTransition(record, Team.from(record).promoteToDefault(actor.subject, now));
  }

  async remove(tenant: string, ref: string, actor: TeamActor): Promise<void> {
    const record = await this.get(tenant, ref);
    if (record.createdBy !== actor.subject && actor.isAdmin !== true)
      throw new BadRequestError(
        "FORBIDDEN",
        { team: record.id },
        "Only the creator or a workspace admin can delete a team.",
      );
    // The gate NAMES the count it refuses on, so it needs the number and nothing else — counting the returned
    // records would fetch every issue the team holds to arrive at the same integer.
    const [teamCount, issueCounts, teams] = await Promise.all([
      this.deps.store.count(tenant),
      this.deps.issues.countByTeam(tenant),
      this.deps.store.list(tenant),
    ]);
    const children = teams.filter((team) => team.parentId === record.id).length;
    Team.from(record).assertDeletable(
      teamCount - 1,
      issueCounts.find((row) => row.teamId === record.id)?.total ?? 0,
      children,
    );
    await this.deps.store.remove(tenant, record.id); // the resolved id — the ref may have been a key
  }

  // --- Roster ---------------------------------------------------------------------------------------------

  async listMembers(tenant: string, ref: string): Promise<TeamMemberRecord[]> {
    const record = await this.get(tenant, ref); // 404 on a foreign/absent team before leaking a roster shape
    return this.deps.store.listMembers(tenant, record.id);
  }

  async addMember(tenant: string, ref: string, subject: string, actor: TeamActor): Promise<TeamMemberRecord> {
    const record = await this.get(tenant, ref);
    const now = this.now();
    const member: TeamMemberRecord = { tenant, teamId: record.id, subject, addedBy: actor.subject, addedAt: now };
    const transition = Team.from(record).memberAdded(subject, actor.subject, now);
    await this.deps.store.addMember(member, this.stamp(tenant, transition.facts));
    await this.deps.store.update(tenant, record.id, transition.patch);
    return member;
  }

  // --- Self-service roster (Linear's "Join teams") ------------------------------------------------------
  // The one roster mutation a member performs on THEMSELVES (teams:join at the transport). It reuses the
  // admin paths below — same facts, same history — with `addedBy` = the joiner, which is what self-service
  // honestly looks like in the ledger.

  async join(tenant: string, ref: string, actor: TeamActor): Promise<TeamMemberRecord> {
    const record = await this.get(tenant, ref);
    // A private team you cannot see reads as absent — joining must not be the probe that confirms it exists.
    if (!(await this.canSeeTeam(tenant, record.id, actor.subject, actor.isAdmin === true)))
      throw new NotFoundError("NOT_FOUND", { team: ref }, "Team not found.");
    const roster = await this.deps.store.listMembers(tenant, record.id);
    if (roster.some((member) => member.subject === actor.subject))
      throw new ConflictError("CONFLICT", { team: record.id }, "You are already on this team.");
    return this.addMember(tenant, record.id, actor.subject, actor);
  }

  async leave(tenant: string, ref: string, actor: TeamActor): Promise<void> {
    const record = await this.get(tenant, ref);
    // Same absence answer as join: "you are not on this team" on a hidden team would confirm it exists.
    if (!(await this.canSeeTeam(tenant, record.id, actor.subject, actor.isAdmin === true)))
      throw new NotFoundError("NOT_FOUND", { team: ref }, "Team not found.");
    await this.removeMember(tenant, record.id, actor.subject, actor);
  }

  async removeMember(tenant: string, ref: string, subject: string, actor: TeamActor): Promise<void> {
    const record = await this.get(tenant, ref);
    const now = this.now();
    const transition = Team.from(record).memberRemoved(subject, actor.subject, now);
    const removed = await this.deps.store.removeMember(
      tenant,
      record.id,
      subject,
      this.stamp(tenant, transition.facts),
    );
    if (!removed)
      throw new NotFoundError("NOT_FOUND", { team: record.id, subject }, "That subject is not on this team.");
    await this.deps.store.update(tenant, record.id, transition.patch);
  }

  // --- Issue identity -------------------------------------------------------------------------------------

  // Resolve the team an issue is being filed into and consume its next number. Explicit team or the workspace
  // default; the default is created on demand, so a workspace that has never seen a team still files fine.
  async allocateForIssue(
    tenant: string,
    teamId: string | undefined,
    by: string,
  ): Promise<{ team: TeamRecord; grant: IssueNumberGrant }> {
    const team = teamId === undefined ? await this.ensureDefault(tenant, by) : await this.get(tenant, teamId);
    const grant = await this.deps.store.allocateIssueNumber(tenant, team.id, this.now());
    if (!grant)
      throw new ConflictError("CONFLICT", { team: team.id }, "The team was removed while the issue was being filed.");
    return { team, grant };
  }

  // WHICH TEAMS THIS SUBJECT MAY SEE — the one place team privacy is decided, so no route re-derives it.
  //
  // Returns `undefined` when nothing is hidden (every team is public, or the caller is an admin): the callers
  // narrow their queries only when there is something to narrow, and an undefined answer means "no filter" —
  // never "no teams", which is the failure mode a `[]` would silently produce.
  //
  // Admins see everything on purpose: an admin can add themselves to any roster in one click, so hiding the
  // data from them would be theatre, and an administrator who cannot answer "what is this team blocked on" is
  // a worse failure than the privacy it pretends to buy.
  async visibleTeamIds(tenant: string, subject: string, isAdmin: boolean): Promise<string[] | undefined> {
    if (isAdmin) return undefined;
    const teams = await this.deps.store.list(tenant);
    if (!teams.some((team) => team.isPrivate)) return undefined;
    const mine = new Set(await this.teamIdsFor(tenant, subject));
    return teams.filter((team) => !team.isPrivate || mine.has(team.id)).map((team) => team.id);
  }

  // "May this subject see that team's work at all" — the single-record counterpart, used where a list filter
  // cannot help (reading one issue by its identifier). A refusal is the CALLER's 404, never a 403: a private
  // team must not be discoverable by the shape of the error.
  async canSeeTeam(tenant: string, teamId: string, subject: string, isAdmin: boolean): Promise<boolean> {
    if (isAdmin) return true;
    const team = await this.deps.store.get(tenant, teamId);
    if (!team || !team.isPrivate) return true;
    return (await this.teamIdsFor(tenant, subject)).includes(teamId);
  }

  // The teams a subject belongs to — the id list an issue query narrows by for "my teams".
  async teamIdsFor(tenant: string, subject: string): Promise<string[]> {
    const teams = await this.deps.store.list(tenant, { member: subject });
    return teams.map((team) => team.id);
  }

  // Stamp → persist (state + facts in one transaction) → nudge the live consumers. Same shape as
  // IssueService.applyTransition, so a team change reaches the feed through the identical path.
  private async applyTransition(record: TeamRecord, transition: TeamTransition): Promise<TeamRecord> {
    const stamped = stampFacts(record.tenant, transition.facts, { newId: this.newId, now: this.now });
    const next = await this.deps.store.update(
      record.tenant,
      record.id,
      transition.patch,
      stamped.map((s) => s.record),
    );
    if (!next) throw new NotFoundError("NOT_FOUND", { team: record.id }, "Team not found.");
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return next;
  }

  private stamp(tenant: string, facts: TeamTransition["facts"]) {
    const stamped = stampFacts(tenant, facts, { newId: this.newId, now: this.now });
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return stamped.map((s) => s.record);
  }
}
