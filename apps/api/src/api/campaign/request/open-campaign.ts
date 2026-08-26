import { CampaignFrameSchema } from "@everdict/contracts";
import { z } from "zod";

// POST /campaigns — open an evolution campaign: the intent-hub issue it journals into, and the frame that
// is FROZEN at open (digest recorded; changing it is a new campaign, never an edit).
export const OpenCampaignBodySchema = z.object({
  issueId: z.string().min(1).describe("The issue this campaign journals into (id or identifier)"),
  frame: CampaignFrameSchema,
});
export type OpenCampaignBody = z.infer<typeof OpenCampaignBodySchema>;
