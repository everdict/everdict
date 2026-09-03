import {
  ISSUE_STATUS_CATEGORY,
  type IssueStatus,
  IssueStatusSchema,
  type PlatformEventDailyCount,
  type WorkspaceActivityAxis,
  type WorkspaceActivityPoint,
  type WorkspaceFlowPoint,
  type WorkspaceQualityPoint,
  activityAxisOf,
} from "@everdict/contracts";
import { addCalendarDays, daysBetween } from "../tracker/calendar.js";

// The workspace pulse's arithmetic — how the recorded past becomes the series a dashboard draws.
//
// Everything here is a pure fold over buckets the caller already read. The reason it is domain code and not
// chart code: a DAY WITH NO ROWS is a zero, and a MEASUREMENT THAT WAS NEVER TAKEN is not — get that backwards
// in the renderer and every quiet weekend draws as a quality cliff. That distinction is business meaning, so it
// is decided once here rather than in each surface that plots it.

// The calendar days of a window, oldest first, both ends inclusive. A dense spine: the log is sparse (a quiet
// day has no rows at all), and a chart that skips those days compresses time into a lie.
export function calendarSpan(from: string, to: string): string[] {
  const span = daysBetween(from, to);
  if (span < 0) return [];
  const days: string[] = [];
  for (let offset = 0; offset <= span; offset += 1) days.push(addCalendarDays(from, offset));
  return days;
}

// Recorded activity per day, split by axis. Buckets whose kind this deployment does not know are DROPPED rather
// than pooled into a fifth band — an unrecognized kind is a reader that is behind, not a category.
export function activityTrend(
  buckets: readonly PlatformEventDailyCount[],
  days: readonly string[],
): WorkspaceActivityPoint[] {
  const byDay = new Map<string, Record<WorkspaceActivityAxis, number>>();
  for (const day of days) byDay.set(day, { work: 0, evaluation: 0, agent: 0, knowledge: 0 });
  for (const bucket of buckets) {
    const axes = byDay.get(bucket.day);
    if (!axes) continue; // a bucket outside the window the caller asked for
    const axis = activityAxisOf(bucket.kind);
    if (axis === undefined) continue;
    axes[axis] += bucket.count;
  }
  return days.map((date) => {
    const axes = byDay.get(date) ?? { work: 0, evaluation: 0, agent: 0, knowledge: 0 };
    return {
      date,
      ...axes,
      total: axes.work + axes.evaluation + axes.agent + axes.knowledge,
    };
  });
}

// Issues that ARRIVED and issues that LEFT, per day. "Left" is a status change whose destination is a completed
// or cancelled status — cancelling is how work leaves the board too, and counting only `done` would draw a
// backlog that never drains.
export function flowTrend(buckets: readonly PlatformEventDailyCount[], days: readonly string[]): WorkspaceFlowPoint[] {
  const created = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const bucket of buckets) {
    if (bucket.kind === "issue.created") {
      created.set(bucket.day, (created.get(bucket.day) ?? 0) + bucket.count);
      continue;
    }
    if (bucket.kind !== "issue.status_changed") continue;
    if (!leavesTheBoard(bucket.outcome)) continue;
    completed.set(bucket.day, (completed.get(bucket.day) ?? 0) + bucket.count);
  }
  return days.map((date) => ({
    date,
    created: created.get(date) ?? 0,
    completed: completed.get(date) ?? 0,
  }));
}

// Did this transition take the issue OFF the board? Read defensively: `outcome` comes from an unvalidated
// payload, and a fact recorded with a status this deployment does not know drops out of the count rather than
// breaking the series.
function leavesTheBoard(outcome: string | undefined): boolean {
  if (outcome === undefined) return false;
  const parsed = IssueStatusSchema.safeParse(outcome);
  if (!parsed.success) return false;
  return isClosedStatus(parsed.data);
}

function isClosedStatus(status: IssueStatus): boolean {
  const category = ISSUE_STATUS_CATEGORY[status];
  return category === "completed" || category === "canceled";
}

// What the batches that finished on each day scored. A day with no batch keeps `passRate` ABSENT (not zero):
// the line has a gap there because nothing was measured, which is the honest drawing of it.
export function qualityTrend(
  batches: readonly { day: string; passRate?: number }[],
  days: readonly string[],
): WorkspaceQualityPoint[] {
  const byDay = new Map<string, { count: number; rates: number[] }>();
  for (const batch of batches) {
    const bucket = byDay.get(batch.day) ?? { count: 0, rates: [] };
    bucket.count += 1;
    if (batch.passRate !== undefined) bucket.rates.push(batch.passRate);
    byDay.set(batch.day, bucket);
  }
  return days.map((date) => {
    const bucket = byDay.get(date);
    if (bucket === undefined) return { date, scorecards: 0 };
    return {
      date,
      scorecards: bucket.count,
      ...(bucket.rates.length > 0 ? { passRate: mean(bucket.rates) } : {}),
    };
  });
}

// The mean of what was actually reported — `undefined` when nothing was, for the same reason the series leaves
// a gap. Exported because the window's headline number and its preceding-window twin are the same arithmetic.
export function meanPassRate(rates: readonly number[]): number | undefined {
  return rates.length > 0 ? mean(rates) : undefined;
}

// Case-weighted mean — a rate is a ratio, and a plain mean of per-batch rates lets a 3-case smoke run move
// the workspace headline as much as a 500-case suite (the same failure mode the analysis engine documents).
// Weight = the cases behind each batch's rate; a batch that cannot say (pre-summary rows) weighs 1.
export interface WeightedRate {
  rate: number;
  weight: number;
}
export function weightedMeanPassRate(rates: readonly WeightedRate[]): number | undefined {
  const total = rates.reduce((sum, r) => sum + Math.max(1, r.weight), 0);
  if (total === 0 || rates.length === 0) return undefined;
  return rates.reduce((sum, r) => sum + r.rate * Math.max(1, r.weight), 0) / total;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
