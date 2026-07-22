import { z } from "zod";

// Re-run body — a full re-run (전체 재실행) of a finished batch. The batch config (dataset/harness/pins/grading
// plan/inline judge model/trace sink/concurrency/trials/subset) is reproduced verbatim from the SOURCE record; the
// only inputs here are the two run-config choices made at submit time that a re-run may adjust. Each unset field
// inherits the original batch's own value.
export const RerunScorecardBodySchema = z.object({
  // Selected Agent Judges override — the judges applied to each case's trace. Unset inherits the original selection;
  // an explicit empty array re-runs with no judges (score with the dataset's graders only).
  judges: z.array(z.object({ id: z.string().min(1), version: z.string().min(1).default("latest") })).optional(),
  // Execution target override — a registered runtime id or a self:* runner target. Unset inherits the original.
  runtime: z.string().min(1).optional(),
});
