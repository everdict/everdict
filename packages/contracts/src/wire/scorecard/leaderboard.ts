import { z } from "zod";

// GET /scorecards/leaderboard — (harness × model) ranking over one dataset (@everdict/suite Leaderboard).
export const LeaderboardResponseSchema = z.object({
  dataset: z.string().describe("Dataset id (the benchmark)"),
  metric: z.string(),
  window: z.enum(["latest", "best"]).describe("Group representative policy: newest createdAt vs highest score"),
  rows: z
    .array(
      z.object({
        rank: z.number().int().describe("1-based, score descending"),
        harness: z.object({ id: z.string(), version: z.string() }),
        model: z.string().optional().describe("models.primary (group key); unset = the unknown group"),
        judgeModels: z
          .array(z.string())
          .optional()
          .describe("Judge model(s) that scored the representative run (fair-comparison check)"),
        scorecardId: z.string().describe("The representative scorecard (window policy)"),
        createdAt: z.string(),
        score: z.number().nullable().describe("passRate first (mean if absent) — the ranking key"),
        passRate: z.number().nullable(),
        mean: z.number().nullable(),
        runs: z.number().int().describe("Number of scorecards folded into this (harness×model) group"),
      }),
    )
    .describe("Score descending (null last)"),
});
