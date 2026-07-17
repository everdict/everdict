import { z } from "zod";

// DELETE /scorecards/:id 200 — hard-delete acknowledgement (record + its fan-out child runs).
export const DeleteScorecardResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  deleted: z.literal(true),
  childRuns: z.number().int().nonnegative(), // fan-out child runs removed alongside the record
});
export type DeleteScorecardResult = z.infer<typeof DeleteScorecardResultSchema>;
