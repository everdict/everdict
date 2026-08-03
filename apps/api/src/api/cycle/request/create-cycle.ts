import { z } from "zod";

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// Planning a team's next iteration. Both dates or neither: the service proposes the window from the team's
// cadence (the day after its latest cycle ends, for `cycleDurationWeeks`), and half a window is a mistake
// rather than a shorthand.
export const CreateCycleBodySchema = z.object({
  teamId: z.string().min(1).max(200),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  startsAt: CalendarDateSchema.optional(),
  endsAt: CalendarDateSchema.optional(),
});

export const UpdateCycleBodySchema = z
  .object({
    // `null` clears the optional text; the dates can only move, never be removed — a cycle without a window is
    // not a cycle.
    name: z.string().min(1).max(200).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    startsAt: CalendarDateSchema.optional(),
    endsAt: CalendarDateSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to update.");

// Closing an iteration. NOT a gate — an iteration ending with unfinished work is the normal case — so the only
// argument is where that work goes. Omitting it leaves the issues on the closed cycle, which is what a team
// that plans the next one later wants.
export const CompleteCycleBodySchema = z.object({
  moveUnfinishedTo: z.string().min(1).max(200).optional(),
});
