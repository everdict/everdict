import { HarnessInstanceSpecSchema } from "../../harness/harness-template.js";

// GET /harnesses/:id/:version/instance 200 — the raw instance (template reference + pins) before resolve.
// SSOT: @everdict/core HarnessInstanceSpecSchema.
export const HarnessInstanceResponseSchema = HarnessInstanceSpecSchema;
