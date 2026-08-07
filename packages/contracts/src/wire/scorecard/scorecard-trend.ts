import { z } from "zod";

// GET /scorecards/trend — one (dataset, metric)'s scorecards in time order + regression vs baseline
// (@everdict/domain ScorecardTrend).
export const ScorecardTrendResponseSchema = z.object({
  dataset: z.string().describe("Dataset id"),
  metric: z.string(),
  baseline: z.string().describe('"first" | "previous" | <scorecardId> — as requested'),
  policyMixed: z
    .boolean()
    .optional()
    .describe(
      "The series mixes batches judged under different verdict policies — points kept, cross-policy regressions suppressed",
    ),
  direction: z
    .enum(["higher_is_better", "lower_is_better"])
    .optional()
    .describe(
      "Reading direction the regression flags were computed under (policy-declared, else pass-rate ⇒ higher). Absent = unknown — no point is flagged regressed, and a delta's sign must not be colored",
    ),
  points: z
    .array(
      z.object({
        scorecardId: z.string(),
        harness: z.string().describe('"id@version"'),
        createdAt: z.string(),
        mean: z.number().nullable(),
        passRate: z.number().nullable(),
        score: z.number().nullable().describe("passRate first (mean if absent) — the trend/regression decision key"),
        deltaVsBaseline: z.number().nullable().describe("score - baseline.score (only when both exist)"),
        regressed: z.boolean().describe("moved AGAINST the series' direction vs baseline (beyond epsilon)"),
        policyDiffers: z
          .boolean()
          .optional()
          .describe("Judged under a different verdict policy than the baseline point — never flagged regressed"),
      }),
    )
    .describe("createdAt ascending"),
});
export type ScorecardTrendResponse = z.infer<typeof ScorecardTrendResponseSchema>;
