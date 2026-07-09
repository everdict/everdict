import { z } from "zod";
import { isValidCron } from "../../../core/schedule/schedule-service.js";

// Scheduled (cron) scorecard request — the definition that flows into ScorecardService.submit on fire (= RunScorecardBody minus the judge override).
export const ScheduleRunTemplateBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});
export const cronExpr = z
  .string()
  .refine(isValidCron, "invalid cron expression (5 fields: minute hour day month weekday).");
export const overlapPolicy = z.enum(["skip", "bufferOne", "allowAll"]);
