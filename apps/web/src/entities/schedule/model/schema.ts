import { z } from 'zod'

// Client mirror of the control plane scheduled (cron) scorecard. The web couples over HTTP only — no @everdict/* dependency.
// GET /schedules response: the workspace's schedule list. Firing (Temporal) is the control plane's responsibility.
export const scheduleOverlapPolicySchema = z.enum(['skip', 'bufferOne', 'allowAll'])
export type ScheduleOverlapPolicy = z.infer<typeof scheduleOverlapPolicySchema>

export const scheduleRunTemplateSchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }),
  judges: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().optional(),
})

export const scheduleSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  overlapPolicy: scheduleOverlapPolicySchema,
  enabled: z.boolean(),
  createdBy: z.string(),
  runTemplate: scheduleRunTemplateSchema,
  lastFiredAt: z.string().optional(),
  lastStatus: z.string().optional(),
  lastScorecardId: z.string().optional(),
  // the authoritative next fire time computed by Temporal (ISO). The control plane attaches it via the driver —
  // if absent (Temporal not deployed) the web approximates from cron. Not stored·read-only.
  nextFireTimes: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Schedule = z.infer<typeof scheduleSchema>
export const schedulesSchema = z.array(scheduleSchema)
