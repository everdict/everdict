import { CampaignFrameFromIssueSchema, CampaignFrameSchema } from "@everdict/contracts";
import { z } from "zod";

// POST /campaigns — open an evolution campaign: the intent-hub issue it journals into, and the frame that
// is FROZEN at open (digest recorded; changing it is a new campaign, never an edit). The frame is either
// complete, or `{ fromIssue: true, … }` — everything but the exam, which the service derives from the issue's
// `case` links and the dataset version they pin (docs/architecture/evolution-routing-spec.md §3).
export const OpenCampaignBodySchema = z.object({
  issueId: z.string().min(1).describe("The issue this campaign journals into (id or identifier)"),
  frame: z.union([CampaignFrameSchema, CampaignFrameFromIssueSchema]),
});
export type OpenCampaignBody = z.infer<typeof OpenCampaignBodySchema>;
