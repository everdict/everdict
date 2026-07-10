import type { z } from "zod";
import { DatasetDiffSchema } from "../../execution/dataset.js";

// GET /datasets/:id/diff 200 — the structural diff of two dataset versions. SSOT: @everdict/contracts DatasetDiffSchema.
export const DatasetDiffResponseSchema = DatasetDiffSchema;
export type DatasetDiffResponse = z.infer<typeof DatasetDiffResponseSchema>;
