import { z } from "zod";

// POST /scorecards/backfill-models — idempotent model-axis backfill over past succeeded scorecards.
export const BackfillModelsResponseSchema = z.object({
  scanned: z.number().int().describe("Succeeded scorecards inspected"),
  updated: z.number().int().describe("Scorecards that gained a models block from their stored traces"),
});
export type BackfillModelsResponse = z.infer<typeof BackfillModelsResponseSchema>;
