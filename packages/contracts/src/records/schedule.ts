import { z } from "zod";

// Scheduled (cron) scorecard — a stored RunScorecardInput + cron expression + policy. Firing reuses ScorecardService.submit.
// This (mutable) store is the SSOT (the UI/API truth); the Temporal Schedule is the execution mechanism (slice 2). Workspace-scoped.
// Design: docs/architecture/scheduled-evals.md.
export const ScheduleOverlapPolicySchema = z.enum(["skip", "bufferOne", "allowAll"]);
export type ScheduleOverlapPolicy = z.infer<typeof ScheduleOverlapPolicySchema>;

// The eval definition that flows into ScorecardService.submit on firing (tenant/submittedBy are filled from the schedule at fire time).
export const ScheduleRunTemplateSchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }),
  judges: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
});
export type ScheduleRunTemplate = z.infer<typeof ScheduleRunTemplateSchema>;

export const ScheduleRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  cron: z.string(), // 5-field cron (validated at the boundary). Converted with timezone into a Temporal spec (slice 2).
  timezone: z.string(), // IANA tz (e.g. "Asia/Seoul"). Default "UTC".
  overlapPolicy: ScheduleOverlapPolicySchema,
  enabled: z.boolean(),
  createdBy: z.string(), // creator subject — the fired run's submittedBy (budget → tenant, resolves private-repo connections).
  runTemplate: ScheduleRunTemplateSchema,
  lastFiredAt: z.string().optional(),
  lastStatus: z.string().optional(), // the previous fire's result (scorecard status or error reason)
  lastScorecardId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;
