import { z } from "zod";

// POST /harnesses/:id/pins 200|201 — durable re-pin outcome. Mirrors RepinResult (core/harness/harness-pin-service.ts).
export const RepinResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string().describe("The registered (or unchanged base) instance version"),
  base: z.string().describe("The instance version used as the merge base"),
  unchanged: z.boolean().describe("True = the merge equals the base, registration skipped (idempotent, 200)"),
  pins: z.record(z.string()).describe("All slot → image pins after the merge"),
});
