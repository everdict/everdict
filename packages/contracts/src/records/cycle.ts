import { z } from "zod";
import { TrackerHistoryEntrySchema } from "./tracker.js";

// CYCLES — a team's iteration (docs/tracker.md). Linear's shape: a numbered, dated window that issues are
// pulled into, so "what are we doing THIS fortnight" is a question with an answer instead of a filter someone
// remembers to apply. A cycle belongs to exactly one TEAM — an iteration is how a working group paces itself,
// and a workspace-wide one would mean nothing to any of them. Projects and initiatives keep answering the other
// question ("did we finish by the date"); the two axes never merge.

// Calendar dates, not instants — a cycle runs from a day to a day, and the literal YYYY-MM-DD round-trips with
// no timezone reinterpretation. Same treatment as a project's target date.
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// Derived from the dates and `completedAt`, never stored: a cycle becomes active because time passed, and a
// stored status would be a lie for exactly as long as nobody wrote to it.
export const CYCLE_STATES = ["upcoming", "active", "completed"] as const;
export const CycleStateSchema = z.enum(CYCLE_STATES);
export type CycleState = z.infer<typeof CycleStateSchema>;

export const CycleRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  teamId: z.string(),
  // Per-team sequence, allocated from the team's own counter the same way an issue number is — "Cycle 7" means
  // the seventh iteration THIS team ran, and two teams counting independently is the point.
  number: z.number().int().positive(),
  // Optional: most cycles are just their number. A name is for the ones that carry a theme.
  name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  startsAt: CalendarDateSchema,
  endsAt: CalendarDateSchema,
  // Set when the cycle is closed explicitly. A cycle whose end date has passed but which nobody closed is NOT
  // completed — it is a cycle somebody forgot, and the list should say so rather than tidy it away.
  completedAt: z.string().optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CycleRecord = z.infer<typeof CycleRecordSchema>;

// What a cycle holds, counted on read (the ProjectRollup precedent — cheap arithmetic beats a cache to
// invalidate on every issue write). `scope` is the estimate sum, which is the number a team plans against;
// issues without an estimate contribute to the counts and not to the points, which is the honest reading.
export const CycleProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  scope: z.number().int().nonnegative(), // total estimate points in the cycle
  completedScope: z.number().int().nonnegative(), // points on issues that are done
  estimated: z.number().int().nonnegative(), // how many issues carry an estimate at all
});
export type CycleProgress = z.infer<typeof CycleProgressSchema>;
