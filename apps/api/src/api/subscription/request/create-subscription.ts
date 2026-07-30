import {
  SubscriptionGovernanceSchema,
  SubscriptionReactionSchema,
  SubscriptionSelectorSchema,
} from "@everdict/contracts";
import { z } from "zod";

// Subscription create body — the contracts record schemas are the SSOT for the three config blocks
// (selector / reaction / governance); this DTO only frames them as a request.
export const CreateSubscriptionBodySchema = z.object({
  name: z.string().min(1).max(120),
  selector: SubscriptionSelectorSchema,
  reaction: SubscriptionReactionSchema,
  governance: SubscriptionGovernanceSchema.optional(),
});
