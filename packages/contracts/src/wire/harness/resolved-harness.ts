import { z } from "zod";
import { HarnessSpecSchema } from "../../harness/harness-spec.js";

// GET /harnesses/:id/:version 200 — the resolved HarnessSpec (template + pins applied). SSOT: @everdict/core.
// The response additionally carries `imageClasses` (re-architecture P1g): per-image provenance
// classification against ALL workspace registries, computed at serve time so no client re-implements
// the rule (the apps/web classifyImageRef mirror was deleted).
export const ImageClassEntrySchema = z.object({
  image: z.string(),
  class: z
    .enum(["workspace", "external", "local", "unqualified"])
    .describe("workspace = matches a workspace registry; local/unqualified = no pull guarantee"),
});
export const ResolvedHarnessResponseSchema = HarnessSpecSchema.and(
  z.object({ imageClasses: z.array(ImageClassEntrySchema).optional() }),
);
