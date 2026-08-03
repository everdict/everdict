import {
  BadRequestError,
  ConflictError,
  type CycleProgress,
  type CycleRecord,
  type CycleState,
  ForbiddenError,
  NotFoundError,
  type TeamRecord,
} from "@everdict/contracts";
import {
  Cycle,
  type CycleEditInput,
  type CycleTransition,
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

// The record plus what it holds and where it sits in time — both derived on the detail read (the ProjectRollup
// precedent), never stored.
export interface CycleDetail extends CycleRecord {
  state: CycleState;
  progress: CycleProgress;
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
    const proposed = nextCycleWindow(latest?.endsAt, this.today(), team.cycleDurationWeeks);
    const now = this.now();
    // The number and the counter move come together, so two cycles can never share "Cycle 7".
    const allocation = { number: team.cycleCounter + 1 };
    const record = Cycle.newCycle({
      id: this.newId(),
      tenant: input.tenant,
      teamId: team.id,
      number: allocation.number,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      startsAt: input.startsAt ?? proposed.startsAt,
      endsAt: input.endsAt ?? proposed.endsAt,
      createdBy: input.createdBy,
      now,
    });
    const stamped = stampFacts(record.tenant, Cycle.creationFacts(record), { newId: this.newId, now: this.now });
    await this.deps.store.create(
      record,
      stamped.map((s) => s.record),
    );
    await this.deps.teams.update(input.tenant, team.id, { cycleCounter: allocation.number, updatedAt: now });
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return record;
  }

  list(tenant: string, filter?: CycleListFilter): Promise<CycleRecord[]> {
    return this.deps.store.list(tenant, filter);
  }

  async get(tenant: string, id: string): Promise<CycleRecord> {
    const record = await this.deps.store.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, `cycle '${id}' not found.`);
    return record;
  }

  async detail(tenant: string, id: string): Promise<CycleDetail> {
    const record = await this.get(tenant, id);
    const issues = await this.deps.issues.list(tenant, { cycleId: id });
    return { ...record, state: cycleStateOf(record, this.today()), progress: cycleProgress(issues) };
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
    if (destination !== undefined)
      for (const issue of unfinished)
        await this.deps.issues.update(tenant, issue.id, { cycleId: destination.id, updatedAt: this.now() });
    return closed;
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
