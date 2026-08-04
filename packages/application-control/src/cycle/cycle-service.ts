import {
  BadRequestError,
  ConflictError,
  type CycleBurndown,
  type CycleProgress,
  type CycleRecord,
  type CycleState,
  ForbiddenError,
  type IssueRecord,
  NotFoundError,
  type TeamRecord,
} from "@everdict/contracts";
import {
  Cycle,
  type CycleCadence,
  type CycleEditInput,
  type CycleTransition,
  Issue,
  cycleBurndown,
  cyclePipelinePlan,
  cycleProgress,
  cycleStateOf,
  nextCycleWindow,
} from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { CycleListFilter, CycleStore } from "../ports/cycle-store.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { TeamStore } from "../ports/team-store.js";

// A team's iterations (docs/tracker.md). The service owns the composition — allocating the number from the
// team, proposing the window, counting what the cycle holds — and the domain owns what any of it MEANS.

// Who a provisioned cycle is credited to. A cadence stood this one up, so crediting whoever happened to open
// the screen would put a name on a plan they never made — the same reasoning `REGRESSION_WATCH_ACTOR` follows.
export const CYCLE_CADENCE_ACTOR = "everdict:cycle-cadence";

export interface CycleActor {
  subject: string;
  isAdmin?: boolean;
}

export interface CreateCycleInput {
  tenant: string;
  createdBy: string;
  teamId: string;
  name?: string;
  description?: string;
  // Absent = the window proposed from the team's cadence (the day after its latest cycle ends, for
  // `cycleDurationWeeks`). Naming one is the exception — a team that skipped a fortnight wants to say so.
  startsAt?: string;
  endsAt?: string;
}

// The record plus what it holds, where it sits in time, and how the work burned down — all derived on the
// detail read (the ProjectRollup precedent), never stored.
export interface CycleDetail extends CycleRecord {
  state: CycleState;
  progress: CycleProgress;
  burndown: CycleBurndown;
}

export interface CycleServiceDeps {
  store: CycleStore;
  // The number comes from the team's counter, and the proposed window from its cadence.
  teams: TeamStore;
  // Read for the progress rollup, and written when a close carries unfinished work forward.
  issues: IssueStore;
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

export class CycleService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: CycleServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private today(): string {
    return this.now().slice(0, 10);
  }

  private async team(tenant: string, teamId: string): Promise<TeamRecord> {
    const record = await this.deps.teams.get(tenant, teamId);
    if (!record) throw new NotFoundError("NOT_FOUND", { team: teamId }, "Team not found.");
    return record;
  }

  private static cadenceOf(team: TeamRecord): CycleCadence {
    return { durationWeeks: team.cycleDurationWeeks, startDay: team.cycleStartDay };
  }

  async create(input: CreateCycleInput): Promise<CycleRecord> {
    const team = await this.team(input.tenant, input.teamId);
    // Both dates or neither: half a window is a mistake, not a shorthand, and guessing the other end would
    // silently produce a cycle nobody asked for.
    if ((input.startsAt === undefined) !== (input.endsAt === undefined))
      throw new BadRequestError(
        "BAD_REQUEST",
        { startsAt: input.startsAt, endsAt: input.endsAt },
        "Give both dates or neither — a cycle with one end is not a window.",
      );
    const latest = (await this.deps.store.list(input.tenant, { teamId: team.id, limit: 1 }))[0];
    const proposed = nextCycleWindow(latest?.endsAt, this.today(), CycleService.cadenceOf(team));
    return this.plant(team, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      startsAt: input.startsAt ?? proposed.startsAt,
      endsAt: input.endsAt ?? proposed.endsAt,
      createdBy: input.createdBy,
    });
  }

  // One cycle into the store, with the team's counter moved in the same operation — the number and the counter
  // move together, so two cycles can never share "Cycle 7". Shared by the member's create and by provisioning.
  private async plant(
    team: TeamRecord,
    input: { name?: string; description?: string; startsAt: string; endsAt: string; createdBy: string },
  ): Promise<CycleRecord> {
    const now = this.now();
    const number = team.cycleCounter + 1;
    const record = Cycle.newCycle({
      id: this.newId(),
      tenant: team.tenant,
      teamId: team.id,
      number,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdBy: input.createdBy,
      now,
    });
    const stamped = stampFacts(record.tenant, Cycle.creationFacts(record), { newId: this.newId, now: this.now });
    await this.deps.store.create(
      record,
      stamped.map((s) => s.record),
    );
    await this.deps.teams.update(team.tenant, team.id, { cycleCounter: number, updatedAt: now });
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return record;
  }

  // A TEAM-scoped list also keeps that team's pipeline stocked: the iteration it is in, plus the upcoming ones
  // its cadence asks for. Provisioning on the read rather than on a timer is deliberate — this runtime has no
  // scheduler that owns tenant data, and the tracker already recovers its other structural invariant (a
  // workspace always has a default team) exactly here. The cost is bounded: the plan is empty on every read but
  // the first one after a window elapses.
  //
  // Only when the team asked for cycles. A team with them off never has a pipeline, so a list read never
  // creates anything, and turning them on is what makes the first one appear.
  async list(tenant: string, filter?: CycleListFilter): Promise<CycleRecord[]> {
    if (filter?.teamId !== undefined) await this.provision(tenant, filter.teamId);
    return this.deps.store.list(tenant, filter);
  }

  // Stand up whatever the team's cadence says should already exist. Idempotent by construction (the plan is
  // computed from what IS there) and best-effort by contract: a member reading a cycle list must not be handed
  // an error because provisioning lost a race with another reader — the next read simply plans again.
  async provision(tenant: string, teamId: string): Promise<CycleRecord[]> {
    const team = await this.deps.teams.get(tenant, teamId);
    if (!team?.cyclesEnabled) return [];
    const existing = await this.deps.store.list(tenant, { teamId });
    const plan = cyclePipelinePlan(existing, this.today(), CycleService.cadenceOf(team), team.upcomingCycleCount);
    const planted: CycleRecord[] = [];
    // Sequentially, and re-reading the team each time: the counter moved on the write before this one, and a
    // stale copy would hand two cycles the same number.
    let current = team;
    for (const window of plan) {
      try {
        planted.push(await this.plant(current, { ...window, createdBy: CYCLE_CADENCE_ACTOR }));
      } catch {
        break;
      }
      const refreshed = await this.deps.teams.get(tenant, teamId);
      if (!refreshed) break;
      current = refreshed;
    }
    // AFTER the pipeline, not before: an expired cycle already fails the "standing" test, so provisioning has
    // just created the iteration its leftover work should move into. Closing first would strand that work in a
    // closed cycle until somebody read the list again.
    if (team.cycleAutoClose) await this.autoClose(tenant, teamId);
    return planted;
  }

  async get(tenant: string, id: string): Promise<CycleRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `cycle '${id}' not found.`);
    return record;
  }

  async detail(tenant: string, id: string): Promise<CycleDetail> {
    const record = await this.get(tenant, id);
    const issues = await this.deps.issues.list(tenant, { cycleId: id });
    const today = this.today();
    return {
      ...record,
      state: cycleStateOf(record, today),
      progress: cycleProgress(issues),
      // Replayed from the issues already in hand — one read, three derivations, no snapshot table to reconcile.
      burndown: cycleBurndown(record, issues, today),
    };
  }

  async update(tenant: string, id: string, fields: CycleEditInput, actor: CycleActor): Promise<CycleRecord> {
    const record = await this.get(tenant, id);
    return this.applyTransition(record, Cycle.from(record).update(fields, actor.subject, this.now()));
  }

  // Close the iteration, and carry what is left forward in the SAME operation. Linear moves unfinished issues
  // to the next cycle on close; doing it here rather than in a background sweep keeps the two halves atomic
  // from the member's point of view — the fact records how many moved, so a retro can still ask.
  async complete(
    tenant: string,
    id: string,
    input: { moveUnfinishedTo?: string },
    actor: CycleActor,
  ): Promise<CycleRecord> {
    const record = await this.get(tenant, id);
    const issues = await this.deps.issues.list(tenant, { cycleId: id });
    const unfinished = issues.filter((issue) => issue.status !== "done" && issue.status !== "cancelled");
    let destination: CycleRecord | undefined;
    if (input.moveUnfinishedTo !== undefined) {
      destination = await this.get(tenant, input.moveUnfinishedTo);
      if (destination.teamId !== record.teamId)
        throw new BadRequestError(
          "BAD_REQUEST",
          { cycle: id, destination: destination.id },
          "That cycle belongs to another team — unfinished work cannot cross teams by being carried over.",
        );
      if (destination.completedAt !== undefined)
        throw new ConflictError(
          "CONFLICT",
          { destination: destination.id },
          "That cycle is already closed — carry the work into an open one.",
        );
      if (destination.id === record.id)
        throw new BadRequestError("BAD_REQUEST", { cycle: id }, "A cycle cannot carry work into itself.");
    }
    const closed = await this.applyTransition(
      record,
      Cycle.from(record).complete(unfinished.length, actor.subject, this.now()),
    );
    // After the close, never before: if the carry-over fails the cycle stays open, which is the recoverable
    // half. The reverse order would leave issues moved out of a cycle that is still running.
    if (destination !== undefined) await this.carryOver(tenant, unfinished, destination.id, actor.subject);
    return closed;
  }

  // Close the iterations whose dates have run out, for a team that asked for that (`cycleAutoClose`). Whatever
  // is still open rolls into the earliest cycle that is still standing — which is the same thing the member's
  // own close dialog does, through the same transitions, so an auto-closed cycle is indistinguishable from a
  // hand-closed one afterwards (`cycle.completed` with its `carriedOver` count, and the move on every issue).
  //
  private async autoClose(tenant: string, teamId: string): Promise<void> {
    const today = this.today();
    const cycles = await this.deps.store.list(tenant, { teamId });
    const expired = cycles.filter((cycle) => cycle.completedAt === undefined && cycle.endsAt < today);
    for (const cycle of expired) {
      // Where the leftovers go: the earliest iteration still standing. Provisioning ran first, so for a team
      // with cycles on there is always one — but if the team set `upcomingCycleCount: 0` AND planted nothing,
      // the work simply stays put rather than being moved somewhere the team never planned.
      const destination = cycles
        .filter((c) => c.completedAt === undefined && c.id !== cycle.id && c.endsAt >= today)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
      try {
        await this.complete(tenant, cycle.id, destination !== undefined ? { moveUnfinishedTo: destination.id } : {}, {
          subject: CYCLE_CADENCE_ACTOR,
        });
      } catch {
        // Already closed by a concurrent reader — the next read sees the settled state.
      }
    }
  }

  // Roll unfinished work into another iteration. Through the ISSUE AGGREGATE, not straight at the store: the
  // move has to land in each issue's history like any other cycle change, or the destination's burn-down counts
  // carried-over work as if it had been there since day one — which is the exact distortion the recorded move
  // exists to remove. A single issue failing does not abort the rest; the cycle is already closed.
  private async carryOver(
    tenant: string,
    issues: readonly IssueRecord[],
    destinationId: string,
    by: string,
  ): Promise<void> {
    for (const issue of issues) {
      try {
        const { patch } = Issue.from(issue).update({ cycleId: destinationId }, by, this.now());
        await this.deps.issues.update(tenant, issue.id, patch);
      } catch {
        // Already in the destination (nothing to update) or a store hiccup — the next issue still moves.
      }
    }
  }

  async remove(tenant: string, id: string, actor: { subject: string; isAdmin: boolean }): Promise<void> {
    const record = await this.get(tenant, id);
    if (record.createdBy !== actor.subject && !actor.isAdmin)
      throw new ForbiddenError(
        "FORBIDDEN",
        { id, action: "cycles:delete" },
        "You are not allowed to delete this cycle (creator or workspace admin only).",
      );
    // An iteration that holds issues is a plan somebody is working to. Emptying it is the member's decision —
    // the same gate a project with issues has.
    const issues = await this.deps.issues.list(tenant, { cycleId: id, limit: 1 });
    if (issues.length > 0)
      throw new ConflictError(
        "CONFLICT",
        { cycle: id },
        "This cycle still holds issues — move them to another cycle first.",
      );
    await this.deps.store.remove(tenant, id);
  }

  private async applyTransition(current: CycleRecord, transition: CycleTransition): Promise<CycleRecord> {
    const stamped = stampFacts(current.tenant, transition.facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.store.update(
      current.tenant,
      current.id,
      transition.patch,
      stamped.map((s) => s.record),
    );
    if (!updated) throw new NotFoundError("NOT_FOUND", { id: current.id }, `cycle '${current.id}' not found.`);
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated;
  }
}
