import type { z } from "zod";
import { RubricSpecSchema } from "../../harness/rubric-spec.js";

// GET /rubrics/:id/versions/:version 200 — the full RubricSpec. SSOT: @everdict/core.
export const RubricResponseSchema = RubricSpecSchema;
export type RubricResponse = z.infer<typeof RubricResponseSchema>;
