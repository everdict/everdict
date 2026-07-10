import { z } from "zod";

// GET /scorecards/estimate — history-based cost/time preflight for a dataset×harness batch
// (ScorecardService.estimate). Honest when there is no history: basis.samples=0 and no estimate block.
export const ScorecardEstimateResponseSchema = z.object({
  basis: z.object({
    scorecards: z.number().int().describe("Number of past succeeded batches the estimate is based on (up to 3)"),
    samples: z.number().int().describe("Number of succeeded child runs sampled (0 = no history, no estimate)"),
  }),
  perCase: z
    .object({
      usdMedian: z.number().describe("Median per-case LLM cost in USD (0 for non-metered workspaces)"),
      durationSecMedian: z.number().describe("Median per-case wall-clock duration in seconds"),
    })
    .optional(),
  estimate: z
    .object({
      cases: z.number().int().describe("Case count the projection uses"),
      usd: z.number().describe("Projected total cost in USD"),
      wallSeconds: z.number().describe("Projected wall-clock duration in seconds at the given concurrency"),
      concurrency: z.number().int(),
    })
    .optional(),
});
export type ScorecardEstimateResponse = z.infer<typeof ScorecardEstimateResponseSchema>;
