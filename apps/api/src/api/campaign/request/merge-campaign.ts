import { CampaignAdoptionProofSchema } from "@everdict/contracts";
import { z } from "zod";

// POST /campaigns/:id/merge — pay the adoption's CODE debt (docs/architecture/code-evolution-loop.md, D5).
// The caller presents the proof the settle recorded; the pull request, its repository and the head the round
// measured are all on the STORED operation, never on the request — a body that could name a pull request would
// be a caller choosing what lands on the default branch.
export const MergeCampaignBodySchema = z.object({
  proof: CampaignAdoptionProofSchema,
});
export type MergeCampaignBody = z.infer<typeof MergeCampaignBodySchema>;
