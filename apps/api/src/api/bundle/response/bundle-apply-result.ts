import { z } from "zod";
import { BundleItemStatusSchema } from "../../../core/bundle/bundle-service.js";

// POST /bundles/apply 200 — per-item fan-out results. Mirrors BundleApplyResult (core/bundle/bundle-service.ts).
// The batch is never aborted: re-applying identical content = ok (registry idempotency), conflicting content =
// conflict, a missing registry = skipped.
export const BundleItemResultSchema = z.object({
  kind: z.string().describe("harness-template | harness | benchmark-recipe | dataset | judge | model | runtime"),
  id: z.string(),
  version: z.string(),
  status: BundleItemStatusSchema,
  message: z.string().optional().describe("Failure/skip detail (absent on ok)"),
});

export const BundleApplyResultSchema = z.object({
  id: z.string().describe("The bundle manifest id"),
  version: z.string().describe("The bundle manifest version"),
  results: z.array(BundleItemResultSchema),
});
