import { z } from "zod";
import { isValidCron } from "./schedule-service.js";

// Scheduled (cron) scorecard request — the definition that flows into ScorecardService.submit on fire (= RunScorecardBody minus the judge override).
const ScheduleRunTemplateBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});
const cronExpr = z.string().refine(isValidCron, "invalid cron expression (5 fields: minute hour day month weekday).");
const overlapPolicy = z.enum(["skip", "bufferOne", "allowAll"]);
export const CreateScheduleBodySchema = z.object({
  name: z.string().min(1),
  cron: cronExpr,
  timezone: z.string().default("UTC"), // IANA tz (e.g. "Asia/Seoul")
  overlapPolicy: overlapPolicy.default("skip"),
  enabled: z.boolean().default(true),
  runTemplate: ScheduleRunTemplateBodySchema,
});
export const UpdateScheduleBodySchema = z.object({
  name: z.string().min(1).optional(),
  cron: cronExpr.optional(),
  timezone: z.string().optional(),
  overlapPolicy: overlapPolicy.optional(),
  enabled: z.boolean().optional(), // pause/resume
  runTemplate: ScheduleRunTemplateBodySchema.optional(),
});
