import { isValidCron } from "@everdict/application-control";
import { z } from "zod";

// Scheduled (cron) scorecard request — the definition that flows into ScorecardService.submit on fire (= RunScorecardBody minus the judge override).
export const ScheduleRunTemplateBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  // pass@k / flakiness — run each case N times per fire (unset = 1). Same knob as a one-off scorecard.
  trials: z.number().int().min(1).max(100).optional(),
  // partial run each fire — a subset of the dataset (cost/smoke). Applied in order: ids → tags → limit.
  cases: z
    .object({
      ids: z.array(z.string().min(1)).min(1).optional(),
      tags: z.array(z.string().min(1)).min(1).optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
    })
    .optional(),
});
export const cronExpr = z
  .string()
  .refine(isValidCron, "invalid cron expression (5 fields: minute hour day month weekday).");
export const overlapPolicy = z.enum(["skip", "bufferOne", "allowAll"]);
