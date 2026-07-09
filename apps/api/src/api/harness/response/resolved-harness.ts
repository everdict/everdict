import { HarnessSpecSchema } from "@everdict/core";

// GET /harnesses/:id/:version 200 — the resolved HarnessSpec (template + pins applied). SSOT: @everdict/core.
export const ResolvedHarnessResponseSchema = HarnessSpecSchema;
