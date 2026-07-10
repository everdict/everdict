import { z } from "zod";

// GET /scorecards/trend — one (dataset, metric)'s scorecards in time order + regression vs baseline
// (@everdict/domain ScorecardTrend).
export const ScorecardTrendResponseSchema = z.object({
  dataset: z.string().describe("Dataset id"),
  metric: z.string(),
  baseline: z.string().describe('"first" | "previous" | <scorecardId> — as requested'),
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
        regressed: z.boolean().describe("score dropped vs baseline (beyond epsilon)"),
      }),
    )
    .describe("createdAt ascending"),
});
export type ScorecardTrendResponse = z.infer<typeof ScorecardTrendResponseSchema>;
