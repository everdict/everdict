import type { z } from "zod";
import { ModelSpecSchema } from "../../harness/model-spec.js";

// GET /models/:id/versions/:version 200 — the full ModelSpec. SSOT: @everdict/core.
export const ModelResponseSchema = ModelSpecSchema;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;
