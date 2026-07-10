import { z } from "zod";

// PUT /datasets/:id/versions/:version/tags 200 — the normalized (trimmed/deduped) tags after replacement.
export const SetVersionTagsResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  tags: z.array(z.string()),
});
export type SetVersionTagsResult = z.infer<typeof SetVersionTagsResultSchema>;
