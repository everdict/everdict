import type { z } from "zod";
import { DatasetSchema } from "../../execution/dataset.js";

// GET /datasets/:id/versions/:version 200 — the full dataset (cases included). SSOT: @everdict/core.
export const DatasetResponseSchema = DatasetSchema;
export type DatasetResponse = z.infer<typeof DatasetResponseSchema>;
