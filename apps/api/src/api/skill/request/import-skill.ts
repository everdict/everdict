import { SkillVisibilitySchema } from "@everdict/contracts";
import { z } from "zod";

// POST /skills/import body — take a store publication (an Everdict example, or a skill another workspace published)
// into this workspace's library as a COPY the members own. `version` pins the exact version copied; omit for latest.
export const ImportSkillBodySchema = z.object({
  source: z.string().min(1), // the publishing workspace ("_everdict" for a managed example)
  id: z.string().min(1), // the capability id
  version: z.string().min(1).optional(),
  visibility: SkillVisibilitySchema.optional(),
});
