import { z } from "zod";

// GET /benchmarks/hf/splits 200 — config/split combinations of an HF dataset. Mirrors HfSplit (@everdict/datasets sources.ts).
export const HfSplitSchema = z.object({
  config: z.string(),
  split: z.string(),
});

export const HfSplitsResponseSchema = z.array(HfSplitSchema);
