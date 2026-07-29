import { z } from "zod";

// Run-experiment body (execution-model.md P1 — phase 1 alone): EXACTLY ONE of `dataset` (registered cases,
// graders stripped for this group) or `task` (a one-off prompt case, EXPERIMENT_ADHOC_REF sentinel).
// kind is pinned to "experiment" — real scorecards keep POST /scorecards; POST /groups only submits the
// ungraded variant until the group surface grows more kinds.
export const RunExperimentBodySchema = z
  .object({
    kind: z.literal("experiment").default("experiment"),
    harness: z.object({ id: z.string(), version: z.string().default("latest") }),
    dataset: z.object({ id: z.string(), version: z.string().default("latest") }).optional(),
    task: z
      .object({
        prompt: z.string().min(1),
        timeoutSec: z.number().int().min(30).max(14_400).optional(), // default 1800 (the service stamps it)
      })
      .optional(),
    // drive the task/cases N times — repetition without a verdict (what does this harness DO, and how stably)
    trials: z.number().int().min(1).max(100).optional(),
    // tenant Runtime id / self:<runner> (placement.target) — same deployment policy as scorecards (400 if absent).
    runtime: z.string().optional(),
    concurrency: z.number().int().min(1).max(512).optional(),
    retries: z.number().int().min(0).max(5).optional(),
    // subset selection (dataset experiments only) — same order as scorecards: ids → tags → limit.
    cases: z
      .object({
        ids: z.array(z.string().min(1)).min(1).optional(),
        tags: z.array(z.string().min(1)).min(1).optional(),
        limit: z.number().int().min(1).max(10_000).optional(),
      })
      .optional(),
  })
  .refine((b) => Boolean(b.dataset) !== Boolean(b.task), {
    message: "An experiment takes exactly one of `dataset` or `task`.",
  });
export type RunExperimentBody = z.infer<typeof RunExperimentBodySchema>;

// Score-group body (execution-model.md P2 — phase 2 detached): the judges to apply over the group's runs.
// Re-scoring a judge REPLACES its previous verdicts; scoring an experiment promotes it to a scorecard.
export const ScoreGroupBodySchema = z.object({
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).min(1),
});
export type ScoreGroupBody = z.infer<typeof ScoreGroupBodySchema>;
