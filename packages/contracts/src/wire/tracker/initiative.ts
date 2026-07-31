import { z } from "zod";
import { InitiativeReadinessSchema, InitiativeRecordSchema } from "../../records/tracker.js";

export const InitiativeResponseSchema = InitiativeRecordSchema;
export type InitiativeResponse = z.infer<typeof InitiativeResponseSchema>;

export const InitiativeListResponseSchema = z.array(InitiativeRecordSchema);
export type InitiativeListResponse = z.infer<typeof InitiativeListResponseSchema>;

// GET /initiatives/:id — the record plus the deployment verdict (readiness over every project's issues).
// Derived on read for the same reason as the project rollup, and it is the one number a release conversation
// actually asks for: is anything still open under this umbrella.
export const InitiativeDetailResponseSchema = InitiativeRecordSchema.extend({
  readiness: InitiativeReadinessSchema,
});
export type InitiativeDetailResponse = z.infer<typeof InitiativeDetailResponseSchema>;
