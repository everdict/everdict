import { z } from "zod";

// GET /benchmarks/hf/datasets 200 — HF Hub search hits. Mirrors HfDatasetHit (@everdict/datasets sources.ts).
export const HfDatasetHitSchema = z.object({
  id: z.string().describe("HF dataset repo id (org/name)"),
  likes: z.number(),
  gated: z.boolean(),
});
export type HfDatasetHit = z.infer<typeof HfDatasetHitSchema>;

export const HfDatasetSearchResponseSchema = z.array(HfDatasetHitSchema);
export type HfDatasetSearchResponse = z.infer<typeof HfDatasetSearchResponseSchema>;
