import { z } from "zod";

// POST /scorecards/:id/rescore-unmeasured — the targeted transient-scoring recovery's outcome. `skipped`
// enumerates the retryable-unmeasured scores a scoring pass CANNOT recover (non-judge in-job grader deaths —
// they need a case re-run via /retry); returning them by coordinate keeps the refusal actionable instead of
// a silent count.
export const RescoreUnmeasuredResultSchema = z.object({
  id: z.string(),
  rescoredJudges: z.array(z.string()).describe("Judge ids whose unmeasured verdicts a scoring pass is recovering"),
  skipped: z
    .array(
      z.object({
        caseId: z.string(),
        trial: z.number().int().optional(),
        graderId: z.string(),
        metric: z.string(),
      }),
    )
    .describe("Retryable-unmeasured non-judge scores — recoverable only by a case re-run (/retry)"),
});
export type RescoreUnmeasuredResult = z.infer<typeof RescoreUnmeasuredResultSchema>;
