import { CapabilityVisibilitySchema } from "@everdict/contracts";
import { z } from "zod";

// PATCH /capabilities/:id/visibility body — change a capability's reach (across every live version). `sharedWith` is
// meaningful only for 'subset' (the target workspaces — the author's own, ⊆ their memberships); it defaults to []
// otherwise. Owner-or-admin (service-enforced); promoting to 'public' additionally requires a workspace admin.
export const SetCapabilityVisibilityBodySchema = z.object({
  visibility: CapabilityVisibilitySchema,
  sharedWith: z.array(z.string()).default([]),
});
