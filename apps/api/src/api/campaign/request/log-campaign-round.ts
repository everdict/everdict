import { z } from "zod";

// POST /campaigns/:id/rounds — one hypothesis tested. The verdict is NOT accepted here: the service derives
// it from the production diff (trials significance + experiment identity), so the loop cannot write its own
// report card.
export const LogCampaignRoundBodySchema = z.object({
  hypothesis: z.string().min(1).max(2000),
  candidateVersion: z.string().min(1).max(100),
  baselineScorecardId: z.string().min(1),
  candidateScorecardId: z.string().min(1),
});
export type LogCampaignRoundBody = z.infer<typeof LogCampaignRoundBodySchema>;
