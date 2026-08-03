import { z } from "zod";
import { InitiativeReadinessSchema, InitiativeRecordSchema } from "../../records/tracker.js";

export const InitiativeResponseSchema = InitiativeRecordSchema;
export type InitiativeResponse = z.infer<typeof InitiativeResponseSchema>;

export const InitiativeListResponseSchema = z.array(InitiativeRecordSchema);
export type InitiativeListResponse = z.infer<typeof InitiativeListResponseSchema>;

// GET /initiatives/:id — the record plus how far along the goal is (progress over every project's issues).
// Derived on read for the same reason as the project rollup, and it is the number the goal's own screen is
// built around: how much of the work under it is finished, and what is left.
export const InitiativeDetailResponseSchema = InitiativeRecordSchema.extend({
  readiness: InitiativeReadinessSchema,
});
export type InitiativeDetailResponse = z.infer<typeof InitiativeDetailResponseSchema>;
