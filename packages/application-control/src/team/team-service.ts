import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  type TeamMemberRecord,
  type TeamRecord,
  type TeamSummary,
} from "@everdict/contracts";
import { Team, type TeamEditInput, type TeamTransition, normalizeTeamKey } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { IssueStore } from "../ports/issue-store.js";
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
  // Seed the roster (the creator is added automatically — someone who makes a team is on it).
  members?: string[];
}

export interface TeamServiceDeps {
  store: TeamStore;
  // Read-only: the delete gate counts what the team still holds, and list summaries count issues per team.
  issues: IssueStore;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

// The auto-created team a workspace falls back to. "Core" rather than "General" because it is the team that
// owns everything nobody has split out yet, and CORE reads correctly in an identifier (CORE-12).
export const DEFAULT_TEAM_KEY = "CORE";
export const DEFAULT_TEAM_NAME = "Core";

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
      isDefault,
      createdBy: input.createdBy,
      now,
    });
    if (isDefault && teamCount > 0) {
      const incumbent = await this.deps.store.getDefault(input.tenant);
      if (incumbent) await this.applyTransition(incumbent, Team.from(incumbent).demoteFromDefault(now));
    }
    await this.deps.store.create(record, this.stamp(input.tenant, Team.creationFacts(record)));
    // Whoever creates a team is on it — a team you cannot see is not a team you meant to make.
    const roster = new Set([input.createdBy, ...(input.members ?? [])]);
    for (const subject of roster) await this.addMember(input.tenant, record.id, subject, { subject: input.createdBy });
    return (await this.deps.store.get(input.tenant, record.id)) ?? record;
  }

  async get(tenant: string, id: string): Promise<TeamRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { team: id }, "Team not found."); // cross-workspace reads 404, never 403
    return record;
  }

  async list(tenant: string, filter?: { member?: string; limit?: number }): Promise<TeamRecord[]> {
    return this.deps.store.list(tenant, filter);
  }

  // Counts a list row wants — derived on read like ProjectRollup, never stored.
  async summary(tenant: string, teamId: string): Promise<TeamSummary> {
    const [members, issues] = await Promise.all([
      this.deps.store.listMembers(tenant, teamId),
      this.deps.issues.list(tenant, { teamId }),
    ]);
    return {
      memberCount: members.length,
      totalIssues: issues.length,
      openIssues: issues.filter((issue) => issue.status !== "done" && issue.status !== "cancelled").length,
    };
  }

  async update(tenant: string, id: string, fields: TeamEditInput, actor: TeamActor): Promise<TeamRecord> {
    const record = await this.get(tenant, id);
    return this.applyTransition(record, Team.from(record).update(fields, actor.subject, this.now()));
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

  async remove(tenant: string, id: string, actor: TeamActor): Promise<void> {
    const record = await this.get(tenant, id);
    if (record.createdBy !== actor.subject && actor.isAdmin !== true)
      throw new BadRequestError("FORBIDDEN", { team: id }, "Only the creator or a workspace admin can delete a team.");
    const [teamCount, issues] = await Promise.all([
      this.deps.store.count(tenant),
      this.deps.issues.list(tenant, { teamId: id }),
    ]);
    Team.from(record).assertDeletable(teamCount - 1, issues.length);
    await this.deps.store.remove(tenant, id);
  }

  // --- Roster ---------------------------------------------------------------------------------------------

  async listMembers(tenant: string, teamId: string): Promise<TeamMemberRecord[]> {
    await this.get(tenant, teamId); // 404 on a foreign/absent team before leaking a roster shape
    return this.deps.store.listMembers(tenant, teamId);
  }

  async addMember(tenant: string, teamId: string, subject: string, actor: TeamActor): Promise<TeamMemberRecord> {
    const record = await this.get(tenant, teamId);
    const now = this.now();
    const member: TeamMemberRecord = { tenant, teamId, subject, addedBy: actor.subject, addedAt: now };
    const transition = Team.from(record).memberAdded(subject, actor.subject, now);
    await this.deps.store.addMember(member, this.stamp(tenant, transition.facts));
    await this.deps.store.update(tenant, teamId, transition.patch);
    return member;
  }

  async removeMember(tenant: string, teamId: string, subject: string, actor: TeamActor): Promise<void> {
    const record = await this.get(tenant, teamId);
    const now = this.now();
    const transition = Team.from(record).memberRemoved(subject, actor.subject, now);
    const removed = await this.deps.store.removeMember(tenant, teamId, subject, this.stamp(tenant, transition.facts));
    if (!removed) throw new NotFoundError("NOT_FOUND", { team: teamId, subject }, "That subject is not on this team.");
    await this.deps.store.update(tenant, teamId, transition.patch);
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
