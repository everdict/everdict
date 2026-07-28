import { z } from "zod";

// GET /capabilities/:id/versions — the live versions of a capability the caller can see + the version→tags display map
// (only versions that have tags). `source` is the OWNER workspace (my own, or a cross-tenant public/subset owner).
export const CapabilityVersionsResponseSchema = z.object({
  id: z.string(),
  source: z.string(),
  versions: z.array(z.string()),
  versionTags: z.record(z.array(z.string())),
});
export type CapabilityVersionsResponse = z.infer<typeof CapabilityVersionsResponseSchema>;
