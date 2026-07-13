import type { z } from "zod";
import { HarnessSpecDiffSchema } from "../../harness/harness-diff.js";

// GET /harnesses/:id/diff 200 — the structural diff of two harness versions (resolved spec). SSOT: @everdict/contracts HarnessSpecDiffSchema.
export const HarnessSpecDiffResponseSchema = HarnessSpecDiffSchema;
export type HarnessSpecDiffResponse = z.infer<typeof HarnessSpecDiffResponseSchema>;
