import type { WorkspacePulse as WireWorkspacePulse } from '@everdict/contracts'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED type is anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
//
// GET /workspace/pulse — how the workspace is doing, in one read (docs/architecture/workspace-pulse.md).
// Two halves: the COUNTS are the state right now, the TREND is what the platform-event log recorded over the
// window. The optional pass rates are the load-bearing part of the shape — a rate that was never measured is
// absent, never zero, and the whole point of the quality series is that it can have gaps.

export const pulseActivityPointSchema = z.object({
  date: z.string(),
  work: z.number(),
  evaluation: z.number(),
  agent: z.number(),
  knowledge: z.number(),
  total: z.number(),
})
export type PulseActivityPoint = z.infer<typeof pulseActivityPointSchema>

export const pulseFlowPointSchema = z.object({
  date: z.string(),
  created: z.number(),
  completed: z.number(),
})
export type PulseFlowPoint = z.infer<typeof pulseFlowPointSchema>

export const pulseQualityPointSchema = z.object({
  date: z.string(),
  scorecards: z.number(),
  passRate: z.number().optional(),
})
export type PulseQualityPoint = z.infer<typeof pulseQualityPointSchema>

export const workspacePulseSchema = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number() }),
  work: z.object({
    open: z.number(),
    inProgress: z.number(),
    regressed: z.number(),
  }),
  goals: z.object({
    initiatives: z.number(),
    projects: z.number(),
    atRisk: z.number(),
  }),
  agents: z.object({
    runs: z.number(),
    openTasks: z.number(),
    awaitingApproval: z.number(),
  }),
  evaluation: z.object({
    scorecards: z.number(),
    runs: z.number(),
    failed: z.number(),
    passRate: z.number().optional(),
    passRateBefore: z.number().optional(),
  }),
  trend: z.object({
    activity: z.array(pulseActivityPointSchema),
    flow: z.array(pulseFlowPointSchema),
    quality: z.array(pulseQualityPointSchema),
  }),
})

// Drift guard — identical-shape entity, so it binds in BOTH directions: a renamed or retyped field on either
// side fails the web typecheck instead of turning into a silently missing number on the home screen.
type AssertAssignable<A extends B, B> = A
type WebWorkspacePulse = z.infer<typeof workspacePulseSchema>
type _pulseFwd = AssertAssignable<WebWorkspacePulse, WireWorkspacePulse>
type _pulseBack = AssertAssignable<WireWorkspacePulse, WebWorkspacePulse>

export type WorkspacePulse = WireWorkspacePulse

export type __workspacePulseDriftGuard = [_pulseFwd, _pulseBack]
