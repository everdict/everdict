import type { ScheduleResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control plane scheduled (cron) scorecard.
// GET /schedules response: the workspace's schedule list. Firing (Temporal) is the control plane's responsibility.
export const scheduleOverlapPolicySchema = z.enum(['skip', 'bufferOne', 'allowAll'])

export const scheduleRunTemplateSchema = z.object({
  // batch mode (dataset×harness). Optional — a trace-evaluation (pull) schedule omits them.
  dataset: z.object({ id: z.string(), version: z.string() }).optional(),
  harness: z.object({ id: z.string(), version: z.string() }).optional(),
  // trace-evaluation mode — judge a rolling window of a registered trace source (no harness run).
  pull: z
    .object({
      source: z.string(),
      correlate: z.enum(['id', 'tag']).optional(),
      scope: z.string().optional(),
      windowHours: z.number(),
    })
    .optional(),
  judges: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
  runtime: z.string().optional(),
  concurrency: z.number().optional(),
  trials: z.number().optional(),
  cases: z
    .object({
      ids: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().optional(),
    })
    .optional(),
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
export const schedulesSchema = z.array(scheduleSchema)

// Drift guard — Schedule is identical-shape (the web models every ScheduleResponse field — including the nested
// runTemplate and nextFireTimes — and no extra), so the guard is bidirectional: a renamed/added field or a
// widened overlap policy on EITHER side fails the web typecheck. (The wire's int/min/max-branded numbers still
// infer `number`, matching the web's plain numbers.)
type AssertAssignable<A extends B, B> = A
type WebSchedule = z.infer<typeof scheduleSchema>
type _scheduleFwd = AssertAssignable<WebSchedule, ScheduleResponse>
type _scheduleBack = AssertAssignable<ScheduleResponse, WebSchedule>

// Exported names alias the contract types (consumers untouched: same identifiers).
export type Schedule = ScheduleResponse
export type ScheduleOverlapPolicy = ScheduleResponse['overlapPolicy']

export type __scheduleDriftGuard = [_scheduleFwd, _scheduleBack]
