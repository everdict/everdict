import type { z } from "zod";
import { HarnessInstanceSpecSchema } from "../../harness/harness-template.js";

// GET /harnesses/:id/:version/instance 200 — the raw instance (template reference + pins) before resolve.
// SSOT: @everdict/contracts HarnessInstanceSpecSchema.
export const HarnessInstanceResponseSchema = HarnessInstanceSpecSchema;
export type HarnessInstanceResponse = z.infer<typeof HarnessInstanceResponseSchema>;
