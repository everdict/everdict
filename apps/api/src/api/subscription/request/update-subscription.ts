import {
  SubscriptionGovernanceSchema,
  SubscriptionReactionSchema,
  SubscriptionSelectorSchema,
} from "@everdict/contracts";
import { z } from "zod";

// Subscription update body — every block optional; a present block replaces the stored one whole
// (selector/reaction/governance are small config values, not documents to merge).
export const UpdateSubscriptionBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  selector: SubscriptionSelectorSchema.optional(),
  reaction: SubscriptionReactionSchema.optional(),
  governance: SubscriptionGovernanceSchema.optional(),
});
