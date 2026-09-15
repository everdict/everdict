import { z } from "zod";
import { WorkspaceCiLinkSchema } from "../../records/workspace-settings.js";

// CI repo-link roster — every list/upsert/remove response returns the full roster after the change.
// The record schema SSOT is WorkspaceCiLinkSchema (records/workspace-settings.ts, in this package) (a link's existence = trusting that repo's
// GitHub Actions OIDC token into this workspace).
export const CiLinkRosterSchema = z.object({
  links: z.array(WorkspaceCiLinkSchema),
});
export type CiLinkRoster = z.infer<typeof CiLinkRosterSchema>;
