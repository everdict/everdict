import { z } from "zod";
import { InitiativeReadinessSchema, InitiativeRecordSchema } from "../../records/tracker.js";

export const InitiativeResponseSchema = InitiativeRecordSchema;
export type InitiativeResponse = z.infer<typeof InitiativeResponseSchema>;

// A LIST row's progress. The detail's `readiness` answers the same question by fetching every issue of every
// project (a fan-out per row would make a 20-goal list 20 fan-outs), so the list computes the same three
// numbers from ONE aggregate over the issue table instead — same rules, different arithmetic: work under a
// cancelled project is off the goal, and a descendant's projects count toward the parent.
export const InitiativeProgressSchema = z.object({
  open: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
});
export type InitiativeProgress = z.infer<typeof InitiativeProgressSchema>;

export const InitiativeListItemSchema = InitiativeRecordSchema.extend({
  progress: InitiativeProgressSchema,
});
export type InitiativeListItem = z.infer<typeof InitiativeListItemSchema>;

export const InitiativeListResponseSchema = z.array(InitiativeListItemSchema);
export type InitiativeListResponse = z.infer<typeof InitiativeListResponseSchema>;

// GET /initiatives/:id — the record plus how far along the goal is (progress over every project's issues).
// Derived on read for the same reason as the project rollup, and it is the number the goal's own screen is
// built around: how much of the work under it is finished, and what is left.
export const InitiativeDetailResponseSchema = InitiativeRecordSchema.extend({
  readiness: InitiativeReadinessSchema,
});
export type InitiativeDetailResponse = z.infer<typeof InitiativeDetailResponseSchema>;
