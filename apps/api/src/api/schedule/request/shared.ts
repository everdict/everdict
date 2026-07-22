import { isValidCron } from "@everdict/application-control";
import { z } from "zod";

// Scheduled (cron) scorecard request — the definition that flows into the fire path. Two mutually-exclusive modes
// (enforced by the refine): batch (dataset×harness → submit) OR trace evaluation (pull → ingestPull over a rolling
// window). Mirrors @everdict/contracts ScheduleRunTemplateSchema (the boundary adds version defaults).
export const ScheduleRunTemplateBodySchema = z
  .object({
    dataset: z.object({ id: z.string(), version: z.string().default("latest") }).optional(),
    harness: z.object({ id: z.string(), version: z.string().default("latest") }).optional(),
    // trace-evaluation mode — pull the recent traces of a registered source over a rolling window and judge them.
    pull: z
      .object({
        source: z.string().min(1), // a registered workspace trace source name
        correlate: z.enum(["id", "tag"]).optional(),
        scope: z.string().min(1).optional(), // platform scope (experiment/project/service)
        windowHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 30), // rolling lookback ending at each fire (24 = last day)
      })
      .optional(),
    judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
    runtime: z.string().optional(),
    concurrency: z.number().int().min(1).max(64).optional(),
    // pass@k / flakiness — run each case N times per fire (unset = 1). Same knob as a one-off scorecard. (batch mode)
    trials: z.number().int().min(1).max(100).optional(),
    // partial run each fire — a subset of the dataset (cost/smoke). Applied in order: ids → tags → limit. (batch mode)
    cases: z
      .object({
        ids: z.array(z.string().min(1)).min(1).optional(),
        tags: z.array(z.string().min(1)).min(1).optional(),
        limit: z.number().int().min(1).max(10_000).optional(),
      })
      .optional(),
  })
  .refine((t) => (t.pull !== undefined) !== (t.dataset !== undefined && t.harness !== undefined), {
    message: "provide EITHER dataset+harness (batch) OR pull (trace evaluation) — not both, not neither",
  });
export const cronExpr = z
  .string()
  .refine(isValidCron, "invalid cron expression (5 fields: minute hour day month weekday).");
export const overlapPolicy = z.enum(["skip", "bufferOne", "allowAll"]);
