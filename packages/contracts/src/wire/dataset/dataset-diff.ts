import { DatasetDiffSchema } from "../../execution/dataset.js";

// GET /datasets/:id/diff 200 — the structural diff of two dataset versions. SSOT: @everdict/core DatasetDiffSchema.
export const DatasetDiffResponseSchema = DatasetDiffSchema;
