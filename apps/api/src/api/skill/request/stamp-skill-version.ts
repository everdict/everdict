import { z } from "zod";

// POST /skills/:id/versions body — name the skill's current content as a version. `bump` says how far the version
// moves (default patch); `version` overrides it with an explicit one, which must order above the current version.
// `note` is the changelog line ("what changed and why"), free text and optional.
export const StampSkillVersionBodySchema = z.object({
  bump: z.enum(["major", "minor", "patch"]).optional(),
  version: z.string().min(1).optional(),
  note: z.string().max(2_000).optional(),
});
