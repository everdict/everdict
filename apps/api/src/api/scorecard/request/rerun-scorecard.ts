import { z } from "zod";

// Re-run body — a full re-run (전체 재실행) of a finished batch. Scoring (grading plan / inline judge model / trace
// sink / trials) is reproduced verbatim from the SOURCE record. The inputs here are the run-config choices a re-run may
// adjust: WHO runs it (judges/runtime) and HOW it is dispatched (concurrency/retries/subset). Each unset field inherits
// the original batch's own value. (Scoring is never overridden — a re-run reproduces the source verdict semantics.)
export const RerunScorecardBodySchema = z.object({
  // Selected Agent Judges override — the judges applied to each case's trace. Unset inherits the original selection;
  // an explicit empty array re-runs with no judges (score with the dataset's graders only).
  judges: z.array(z.object({ id: z.string().min(1), version: z.string().min(1).default("latest") })).optional(),
  // Execution target override — a registered runtime id or a self:* runner target. Unset inherits the original.
  runtime: z.string().min(1).optional(),
  // Dispatch concurrency override — max cases dispatched at once. Unset inherits the original batch concurrency.
  concurrency: z.number().int().min(1).max(512).optional(),
  // Per-case transient dispatch retries override (throw-only). Unset inherits the original.
  retries: z.number().int().min(0).max(5).optional(),
  // Subset override — re-run only these cases instead of the original scorecard's subset. Applied in order: ids → tags
  // → limit. Unset re-runs the SAME subset the source ran.
  cases: z
    .object({
      ids: z.array(z.string().min(1)).min(1).optional(),
      tags: z.array(z.string().min(1)).min(1).optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
    })
    .optional(),
});
