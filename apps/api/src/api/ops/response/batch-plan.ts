import { z } from "zod";

// POST /internal/batches/:id/plan — the case plan a Temporal batch workflow drives (ScorecardService.planBatch).
export const BatchPlanResponseSchema = z.object({
  caseIds: z.array(z.string()).describe("Case ids still to dispatch (already-settled cases are excluded)"),
  concurrency: z.number().int().describe("The batch's persisted dispatch concurrency"),
});
