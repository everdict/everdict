import { z } from "zod";

// POST /internal/batches/:id/case — one batch case executed by the control plane on the workflow's behalf
// (ScorecardService.runBatchCase — idempotent: an already-settled case is skipped).
export const BatchCaseResponseSchema = z.object({
  settled: z.boolean().describe("The case has a settled result after this call"),
  skipped: z.boolean().optional().describe("true when the case was already settled (idempotent re-drive)"),
});
