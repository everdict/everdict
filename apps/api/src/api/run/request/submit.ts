import { EvalCaseSchema, JudgeRunConfigSchema } from "@everdict/core";
import { z } from "zod";

export const SubmitBodySchema = z.object({
  harness: z.object({ id: z.string(), version: z.string() }),
  case: EvalCaseSchema,
  runtime: z.string().optional(), // tenant Runtime id to execute on (placement.target). Absent = default backend (symmetric with scorecard).
  trigger: z.string().optional(), // origin of this run (activity-view source axis): web|api… (unset = direct API). Client metadata.
  webhookUrl: z.string().url().optional(),
  meterUsage: z.boolean().optional(), // per-request usage-metering override (unset = workspace policy)
  judge: JudgeRunConfigSchema.optional(), // per-request judge-model override (unset = workspace default)
});
