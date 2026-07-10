import type { z } from "zod";
import { HarnessTemplateSpecSchema } from "../../harness/harness-template.js";

// GET /harness-templates/:id/:version 200 — the template (category) structure spec. SSOT: @everdict/contracts.
export const HarnessTemplateResponseSchema = HarnessTemplateSpecSchema;
export type HarnessTemplateResponse = z.infer<typeof HarnessTemplateResponseSchema>;
