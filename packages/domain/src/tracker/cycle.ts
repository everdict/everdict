import type { CycleProgress, CycleRecord, CycleState, IssueRecord, PlatformFact } from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { appendHistory } from "./history.js";
import { isOpenIssueStatus } from "./issue.js";

// The Cycle aggregate (docs/tracker.md) — a team's iteration. Same {patch, facts} transition contract as the
// rest of the tracker, so the store persists a state change and its fact in one write.
export interface CycleTransition {
  patch: Partial<CycleRecord>;
  facts: PlatformFact[];
}

export interface NewCycleInput {
  id: string;
  tenant: string;
  teamId: string;
  number: number;
  name?: string;
  description?: string;
  startsAt: string;
  endsAt: string;
  createdBy: string;
  now: string;
}

export interface CycleEditInput {
  name?: string | null;
  description?: string | null;
  startsAt?: string;
  endsAt?: string;
}

// A cycle's state is DERIVED from its dates and whether it was closed — never stored. A cycle becomes active
// because time passed, and a stored status would be wrong for exactly as long as nobody wrote to it. `today` is
// a parameter rather than a clock read, so every row in one response is judged against the same day.
export function cycleStateOf(cycle: CycleRecord, today: string): CycleState {
  if (cycle.completedAt !== undefined) return "completed";
  if (today < cycle.startsAt) return "upcoming";
  return "active";
}

// What the cycle holds, counted from the issues the caller already fetched — pure arithmetic, run on the detail
// read like ProjectRollup. `scope` counts POINTS and the counts count ISSUES: an unestimated issue is real work
// that contributes nothing to the points, and pretending otherwise (counting it as 1) would quietly inflate
// every burn-down a team draws.
export function cycleProgress(issues: readonly IssueRecord[]): CycleProgress {
  let open = 0;
  let done = 0;
  let scope = 0;
  let completedScope = 0;
  let estimated = 0;
  for (const issue of issues) {
    const points = issue.estimate ?? 0;
    if (issue.estimate !== undefined) estimated += 1;
    scope += points;
    if (isOpenIssueStatus(issue.status)) open += 1;
    else {
      // `done` here means SETTLED (done or cancelled) — a cancelled issue is not remaining work, and a burn-down
      // that kept counting it would never reach the floor.
      done += 1;
      completedScope += points;
    }
  }
  return { total: issues.length, open, done, scope, completedScope, estimated };
}

// Calendar-date arithmetic over the literal YYYY-MM-DD, done in UTC so it never depends on where the process
// runs: a cycle's span is a count of days, not an instant, and reading these through a local timezone is how a
// fortnight silently becomes 13 or 15 days.
export function addCalendarDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) throw new BadRequestError("BAD_REQUEST", { date }, "Expected a YYYY-MM-DD date.");
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// Where the next iteration starts: the day after the team's latest one ends, or today for a team's first.
// Proposed, never imposed — the caller may pass its own dates, and a team that skipped a fortnight does not
// want a cycle backdated into the gap.
export function nextCycleWindow(
  latestEndsAt: string | undefined,
  today: string,
  durationWeeks: number,
): { startsAt: string; endsAt: string } {
  const startsAt = latestEndsAt !== undefined && latestEndsAt >= today ? addCalendarDays(latestEndsAt, 1) : today;
  // Inclusive end: a two-week cycle starting Monday ends on the Sunday thirteen days later, not on the next
  // Monday — otherwise consecutive cycles overlap on their boundary day.
  return { startsAt, endsAt: addCalendarDays(startsAt, durationWeeks * 7 - 1) };
}

export class Cycle {
  private constructor(private readonly record: CycleRecord) {}

  static from(record: CycleRecord): Cycle {
    return new Cycle(record);
  }

  static newCycle(input: NewCycleInput): CycleRecord {
    if (input.endsAt < input.startsAt)
      throw new BadRequestError(
        "BAD_REQUEST",
        { startsAt: input.startsAt, endsAt: input.endsAt },
        "A cycle cannot end before it starts.",
      );
    return {
      id: input.id,
      tenant: input.tenant,
      teamId: input.teamId,
      number: input.number,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: "created",
          detail: { number: input.number, startsAt: input.startsAt, endsAt: input.endsAt },
        },
      ],
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: CycleRecord): PlatformFact[] {
    return [
      {
        kind: "cycle.created",
        subject: { type: "cycle", id: record.id },
        actor: record.createdBy,
        payload: {
          teamId: record.teamId,
          number: record.number,
          startsAt: record.startsAt,
          endsAt: record.endsAt,
        },
        message: `Cycle ${record.number} planned`,
      },
    ];
  }

  get teamId(): string {
    return this.record.teamId;
  }

  get isCompleted(): boolean {
    return this.record.completedAt !== undefined;
  }

  update(fields: CycleEditInput, by: string, now: string): CycleTransition {
    if (this.isCompleted)
      throw new ConflictError(
        "CONFLICT",
        { cycle: this.record.id },
        "This cycle is closed — a finished iteration is a record, not a plan.",
      );
    const changed: string[] = [];
    const patch: Partial<CycleRecord> = {};
    if (fields.name !== undefined) {
      const next = fields.name === null ? undefined : fields.name;
      if (next !== this.record.name) {
        patch.name = next;
        changed.push("name");
      }
    }
    if (fields.description !== undefined) {
      const next = fields.description === null ? undefined : fields.description;
      if (next !== this.record.description) {
        patch.description = next;
        changed.push("description");
      }
    }
    const startsAt = fields.startsAt ?? this.record.startsAt;
    const endsAt = fields.endsAt ?? this.record.endsAt;
    if (endsAt < startsAt)
      throw new BadRequestError("BAD_REQUEST", { startsAt, endsAt }, "A cycle cannot end before it starts.");
    if (startsAt !== this.record.startsAt) {
      patch.startsAt = startsAt;
      changed.push("startsAt");
    }
    if (endsAt !== this.record.endsAt) {
      patch.endsAt = endsAt;
      changed.push("endsAt");
    }
    if (changed.length === 0) throw new BadRequestError("BAD_REQUEST", { cycle: this.record.id }, "Nothing to update.");
    patch.history = appendHistory(this.record.history, { at: now, by, event: "updated", detail: { changed } });
    patch.updatedAt = now;
    return { patch, facts: [] };
  }

  // Closing an iteration. Unlike a project's completion this is NOT a gate: an iteration ending with unfinished
  // work is the normal case — that is what the next cycle is for. What the transition records is how much was
  // left, and the caller moves those issues (the service does it in the same operation), so "we closed cycle 7
  // with four issues open" stays answerable long after they were rolled forward.
  complete(carriedOver: number, by: string, now: string): CycleTransition {
    if (this.isCompleted)
      throw new ConflictError("CONFLICT", { cycle: this.record.id }, "This cycle is already closed.");
    const detail = { number: this.record.number, carriedOver };
    return {
      patch: {
        completedAt: now,
        history: appendHistory(this.record.history, { at: now, by, event: "completed", detail }),
        updatedAt: now,
      },
      facts: [
        {
          kind: "cycle.completed",
          subject: { type: "cycle", id: this.record.id },
          actor: by,
          payload: { teamId: this.record.teamId, ...detail },
          message: `Cycle ${this.record.number} closed${carriedOver > 0 ? ` — ${carriedOver} carried over` : ""}`,
        },
      ],
    };
  }
}
