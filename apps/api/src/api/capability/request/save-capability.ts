import { CapabilitySpecSchema, CapabilityVisibilitySchema } from "@everdict/contracts";
import { z } from "zod";

// PUT /capabilities/:id body — author (create or edit) a capability. Version-free upsert: a new id creates 1.0.0, a
// content change (name/description/spec) on an existing id patch-bumps to a NEW immutable version. `visibility` /
// `sharedWith` are honored ONLY when creating the first version — editing inherits the current reach (change it via
// PATCH /capabilities/:id/visibility, which gates public → admin), so a content edit never silently re-shares.
export const SaveCapabilityBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  spec: CapabilitySpecSchema,
  visibility: CapabilityVisibilitySchema.optional(),
  sharedWith: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
