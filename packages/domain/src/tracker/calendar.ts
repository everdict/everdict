import { BadRequestError } from "@everdict/contracts";

// ── CALENDAR-DATE ARITHMETIC, IN UTC ─────────────────────────────────────────────────────────────────
//
// These lived in `tracker/cycle.ts` and outlived it: they are arithmetic over the literal `YYYY-MM-DD`, not
// anything about iterations. The tracker's date windows (a project's target date, an initiative's span, the
// workspace pulse's day series) are counts of DAYS rather than instants, and reading them through a local
// timezone is how a fortnight silently becomes 13 or 15 days.
export function addCalendarDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) throw new BadRequestError("BAD_REQUEST", { date }, "Expected a YYYY-MM-DD date.");
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// The weekday of a calendar date, read in UTC for the same reason. 0 = Sunday … 6 = Saturday.
export function weekdayOf(date: string): number {
  const at = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) throw new BadRequestError("BAD_REQUEST", { date }, "Expected a YYYY-MM-DD date.");
  return at.getUTCDay();
}

// Whole days from `from` to `to`, both calendar dates. Negative when `to` precedes `from`.
export function daysBetween(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end))
    throw new BadRequestError("BAD_REQUEST", { from, to }, "Expected a YYYY-MM-DD date.");
  return Math.round((end - start) / 86_400_000);
}
