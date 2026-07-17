import { GraderSpecSchema } from "@everdict/contracts";
import { z } from "zod";

// Re-run body — a full re-run (전체 재실행) of a finished batch, optionally applying a re-score override. The batch
// config (dataset/harness/pins/judges/runtime/concurrency/trials/subset) is reproduced from the SOURCE record, so
// the only inputs here are the optional overrides; each unset field inherits the original batch's own value.
export const RerunScorecardBodySchema = z.object({
  // Run-time grading plan — replaces every case's default graders for the re-run batch. Unset = the original plan.
  graders: z.array(GraderSpecSchema).min(1).optional(),
  // Inline judge scoring-model override — a registered Model id for the inline judge grader. Unset = the original.
  judgeModel: z.string().min(1).optional(),
  // Per-batch trace-sink override — a configured workspace sink name, or "none" to suppress export. Unset = the original.
  traceSink: z.string().min(1).optional(),
});
