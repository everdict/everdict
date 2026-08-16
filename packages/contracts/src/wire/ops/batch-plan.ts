import { z } from "zod";
import { CaseKeySchema } from "../../execution/case-key.js";

// POST /internal/batches/:id/plan — the case plan a Temporal batch workflow drives (ScorecardService.planBatch).
export const BatchPlanResponseSchema = z.object({
  caseIds: z
    .array(z.string())
    .describe(
      "LEGACY projection of `items`: one entry per case id still to dispatch. A trialled batch has several " +
        "executions per id, so this list cannot express the plan — it exists for workflow executions started " +
        "before `items` shipped, which by construction are never trialled.",
    ),
  items: z
    .array(CaseKeySchema)
    .describe("The plan's actual unit: the (case, trial) pairs still to dispatch (already-settled ones excluded)"),
  concurrency: z.number().int().describe("The batch's persisted dispatch concurrency"),
});
export type BatchPlanResponse = z.infer<typeof BatchPlanResponseSchema>;
