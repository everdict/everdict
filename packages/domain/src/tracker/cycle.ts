import type {
  CycleBurndown,
  CycleProgress,
  CycleRecord,
  CycleState,
  IssueRecord,
  IssueStatus,
  PlatformFact,
  TrackerHistoryEntry,
} from "@everdict/contracts";
import { BadRequestError, ConflictError, IssueStatusSchema } from "@everdict/contracts";
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

// The weekday of a calendar date, read in UTC for the same reason the arithmetic above is: a fortnight must not
// become 13 days because the process moved timezone. 0 = Sunday … 6 = Saturday, matching `Date#getUTCDay`.
export function weekdayOf(date: string): number {
  const at = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) throw new BadRequestError("BAD_REQUEST", { date }, "Expected a YYYY-MM-DD date.");
  return at.getUTCDay();
}

// The most recent `startDay` on or before `date`. Backwards, never forwards: a team that turns cycles on today
// should BE in an iteration today, and aligning forward would leave it with up to six days of no cycle at all —
// during which every issue it files belongs to nothing.
export function alignToStartDay(date: string, startDay: number): string {
  const back = (weekdayOf(date) - startDay + 7) % 7;
  return back === 0 ? date : addCalendarDays(date, -back);
}

// A team's pace: how long an iteration runs and which weekday it starts on. Both come off the team record, and
// they travel together because neither means anything alone — a two-week cycle still has to say two weeks from
// WHEN, or every team drifts to whichever day somebody happened to plan its first one.
export interface CycleCadence {
  durationWeeks: number;
  startDay: number;
}

// Where the next iteration starts: the day after the team's latest one ends, so a sequence stays contiguous —
// or, when there is no live sequence to continue, the team's start weekday on or before today, so the new cycle
// is one the team is already inside. Proposed, never imposed: the caller may pass its own dates, and a team
// that skipped a fortnight does not want a cycle backdated into the gap.
export function nextCycleWindow(
  latestEndsAt: string | undefined,
  today: string,
  cadence: CycleCadence,
): { startsAt: string; endsAt: string } {
  const startsAt =
    latestEndsAt !== undefined && latestEndsAt >= today
      ? // Continuing a live sequence — NOT re-aligned. The sequence is already on the team's weekday, and
        // re-aligning here would open a gap between two cycles that are supposed to touch.
        addCalendarDays(latestEndsAt, 1)
      : alignToStartDay(today, cadence.startDay);
  // Inclusive end: a two-week cycle starting Monday ends on the Sunday thirteen days later, not on the next
  // Monday — otherwise consecutive cycles overlap on their boundary day.
  return { startsAt, endsAt: addCalendarDays(startsAt, cadence.durationWeeks * 7 - 1) };
}

// A cycle is STANDING when it has not ended and nobody has closed it — the one running now plus the ones
// planned in front of it. This is what the pipeline counts, and why it counts nothing else: a closed cycle and
// a cycle whose dates have passed are both history, however the team feels about them.
function isStanding(cycle: CycleRecord, today: string): boolean {
  return cycle.completedAt === undefined && cycle.endsAt >= today;
}

// What has to exist for a team with cycles on: the iteration it is in, plus `upcoming` more in front of it.
// Returns the windows to CREATE, in order — empty when the pipeline is already deep enough.
//
// It only ever APPENDS after the latest cycle, never inserts into a gap. That is the whole safety argument: a
// team that paused for a month gets one fresh cycle starting this week rather than a month of backfilled ones
// nobody worked in, and the count of standing cycles rises by exactly one per window, so this terminates.
export function cyclePipelinePlan(
  existing: readonly CycleRecord[],
  today: string,
  cadence: CycleCadence,
  upcoming: number,
): { startsAt: string; endsAt: string }[] {
  // One to be in, plus the ones planned ahead. `upcoming: 0` still means the team is always inside a cycle.
  const wanted = upcoming + 1;
  let standing = existing.filter((cycle) => isStanding(cycle, today)).length;
  if (standing >= wanted) return [];
  // The sequence continues from the HIGHEST end date, not the highest number: a team that hand-planned a window
  // out of order would otherwise get an overlapping one back.
  let latestEndsAt = existing.reduce<string | undefined>(
    (latest, cycle) => (latest === undefined || cycle.endsAt > latest ? cycle.endsAt : latest),
    undefined,
  );
  const windows: { startsAt: string; endsAt: string }[] = [];
  while (standing < wanted) {
    const window = nextCycleWindow(latestEndsAt, today, cadence);
    windows.push(window);
    latestEndsAt = window.endsAt;
    standing += 1;
  }
  return windows;
}

// How many days of the iteration are left, counting today. Zero once the end date has passed — a cycle nobody
// closed does not go negative, it is simply out of days.
export function cycleDaysRemaining(cycle: CycleRecord, today: string): number {
  if (today > cycle.endsAt) return 0;
  return daysBetween(today < cycle.startsAt ? cycle.startsAt : today, cycle.endsAt) + 1;
}

// Whole days from `from` to `to`, both calendar dates. Negative when `to` precedes `from`.
export function daysBetween(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end))
    throw new BadRequestError("BAD_REQUEST", { from, to }, "Expected a YYYY-MM-DD date.");
  return Math.round((end - start) / 86_400_000);
}

// The status an entry MOVED an issue into, when it is a status move at all. Read defensively: `detail` is an
// unvalidated bag, and an entry with a mistyped status has to drop out of the replay rather than break it.
function movedTo(entry: TrackerHistoryEntry): IssueStatus | undefined {
  const parsed = IssueStatusSchema.safeParse(entry.detail?.to);
  return parsed.success ? parsed.data : undefined;
}

function movedFrom(entry: TrackerHistoryEntry): IssueStatus | undefined {
  const parsed = IssueStatusSchema.safeParse(entry.detail?.from);
  return parsed.success ? parsed.data : undefined;
}

// The status an issue held at the END of a given calendar day, replayed from its own history. Comparison is on
// the entry's calendar DAY (UTC), never on the instant, so "as of that day" means the same thing here as the
// dates on the cycle do.
export function issueStatusOn(issue: IssueRecord, day: string): IssueStatus {
  const moves = issue.history.filter((entry) => movedTo(entry) !== undefined);
  let held: IssueStatus | undefined;
  for (const entry of moves) {
    if (entry.at.slice(0, 10) > day) break;
    held = movedTo(entry);
  }
  if (held !== undefined) return held;
  // Nothing had moved it yet — so it still held whatever the first recorded move took it OUT of. That is an
  // exact reconstruction, not a guess; only an issue that never moved at all falls back to its current status.
  const first = moves[0];
  return (first !== undefined ? movedFrom(first) : undefined) ?? issue.status;
}

// The cycle an entry MOVED the issue into, when it recorded one. `null` is a real value here ("no cycle"), and
// an ABSENT key means the edit predates cycle moves being recorded — the two must not collapse, because only
// the second one licenses the "it was there all along" fallback.
function movedToCycle(entry: TrackerHistoryEntry): string | null | undefined {
  const to = entry.detail?.cycleTo;
  if (to === null) return null;
  return typeof to === "string" ? to : undefined;
}

function movedFromCycle(entry: TrackerHistoryEntry): string | null | undefined {
  const from = entry.detail?.cycleFrom;
  if (from === null) return null;
  return typeof from === "string" ? from : undefined;
}

// Was this issue in the given cycle at the END of that day? Replayed exactly like `issueStatusOn`: apply every
// recorded move up to the day, and fall back to the state BEFORE the first recorded one when none applies.
//
// An issue with no recorded move at all is taken to have been in the cycle for the whole window. That is the
// honest reading of a missing record, not an assumption: it IS in the cycle now (the caller only passes issues
// the cycle holds), and nothing says when it arrived.
export function issueInCycleOn(issue: IssueRecord, cycleId: string, day: string): boolean {
  const moves = issue.history.filter((entry) => movedToCycle(entry) !== undefined);
  let held: string | null | undefined;
  for (const entry of moves) {
    if (entry.at.slice(0, 10) > day) break;
    held = movedToCycle(entry);
  }
  if (held !== undefined) return held === cycleId;
  const first = moves[0];
  // Before the first recorded move it held whatever that move took it out of — an exact reconstruction.
  if (first !== undefined) {
    const before = movedFromCycle(first);
    if (before !== undefined) return before === cycleId;
  }
  return issue.cycleId === cycleId;
}

// The team's burn-down: for every elapsed day of the window, what was committed and what was still open at the
// end of it. Pure replay over the issues the caller already fetched — see `CycleBurndownPointSchema` for what
// this can and cannot say.
export function cycleBurndown(cycle: CycleRecord, issues: readonly IssueRecord[], today: string): CycleBurndown {
  // A cycle that has not started has nothing to draw; one that ran to the end draws the whole window.
  const last = today < cycle.endsAt ? today : cycle.endsAt;
  const span = daysBetween(cycle.startsAt, last);
  if (span < 0) return [];
  const points: CycleBurndown = [];
  for (let offset = 0; offset <= span; offset += 1) {
    const date = addCalendarDays(cycle.startsAt, offset);
    let scope = 0;
    let remaining = 0;
    let remainingIssues = 0;
    for (const issue of issues) {
      // Work that had not joined the cycle yet is not part of that day at all — neither committed nor remaining.
      if (!issueInCycleOn(issue, cycle.id, date)) continue;
      scope += issue.estimate ?? 0;
      if (!isOpenIssueStatus(issueStatusOn(issue, date))) continue;
      remaining += issue.estimate ?? 0;
      remainingIssues += 1;
    }
    points.push({ date, scope, remaining, remainingIssues });
  }
  return points;
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
