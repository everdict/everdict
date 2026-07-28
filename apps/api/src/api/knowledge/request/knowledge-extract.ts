import { z } from "zod";

// POST /knowledge/extract body — mine a discussion for knowledge-entry candidates. `source.kind` accepts only what
// the extractor supports today (comment threads; agent sessions can follow — their conversations already have the
// authored path in-band). `source.id` may be any comment in the thread. `model` = the workspace's registered model
// that runs the extraction (a real billable call, like skill-generate).
export const ExtractKnowledgeBodySchema = z.object({
  source: z.object({
    kind: z.literal("comment"),
    id: z.string().min(1),
  }),
  model: z.string().min(1),
});
