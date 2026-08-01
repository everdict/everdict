import type {
  InitiativeBlocker as WireInitiativeBlocker,
  InitiativeProjectSummary as WireInitiativeProjectSummary,
  InitiativeReadiness as WireInitiativeReadiness,
  InitiativeRecord as WireInitiativeRecord,
  InitiativeStatus as WireInitiativeStatus,
} from '@everdict/contracts'
import type { InitiativeDetailResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

import { issueStatusSchema, trackerHistoryEntrySchema } from '@/entities/issue'
import { projectRollupSchema, projectStatusSchema } from '@/entities/project'

// The eval tracker's Initiative — the deployment umbrella over projects (docs/tracker.md). Runtime boundary
// validation stays here (zod v4); the EXPORTED types come from @everdict/contracts (`import type` only).

export const INITIATIVE_STATUSES = ['active', 'completed', 'cancelled'] as const
export const initiativeStatusSchema = z.enum(INITIATIVE_STATUSES)

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const initiativeSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: initiativeStatusSchema,
  targetDate: calendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const initiativesSchema = z.array(initiativeSchema)

export const initiativeBlockerSchema = z.object({
  projectId: z.string().optional(),
  issueId: z.string(),
  // 이슈를 부르는 이름(`ENG-12`) — 릴리스 카드가 이슈를 다시 읽지 않고도 슬러그로 링크한다.
  identifier: z.string(),
  title: z.string(),
  status: issueStatusSchema,
})

export const initiativeProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: projectStatusSchema,
  targetDate: calendarDateSchema.optional(),
  completedAt: z.string().optional(),
  rollup: projectRollupSchema,
})

// The deployment verdict: `ready` counts open issues across every NON-CANCELLED project regardless of that
// project's own status — a completed project whose issue later regressed still blocks the release.
export const initiativeReadinessSchema = z.object({
  ready: z.boolean(),
  openIssues: z.number(),
  totalIssues: z.number(),
  projects: z.array(initiativeProjectSummarySchema),
  blockers: z.array(initiativeBlockerSchema),
})

export const initiativeDetailSchema = initiativeSchema.extend({
  readiness: initiativeReadinessSchema,
})

// Drift guard — mutually assignable with the wire contract in both directions.
type AssertAssignable<A extends B, B> = A
type WebInitiative = z.infer<typeof initiativeSchema>
type _initiativeFwd = AssertAssignable<WebInitiative, WireInitiativeRecord>
type _initiativeBack = AssertAssignable<WireInitiativeRecord, WebInitiative>
type _statusFwd = AssertAssignable<z.infer<typeof initiativeStatusSchema>, WireInitiativeStatus>
type _statusBack = AssertAssignable<WireInitiativeStatus, z.infer<typeof initiativeStatusSchema>>
type _blockerFwd = AssertAssignable<z.infer<typeof initiativeBlockerSchema>, WireInitiativeBlocker>
type _blockerBack = AssertAssignable<WireInitiativeBlocker, z.infer<typeof initiativeBlockerSchema>>
type _summaryFwd = AssertAssignable<
  z.infer<typeof initiativeProjectSummarySchema>,
  WireInitiativeProjectSummary
>
type _summaryBack = AssertAssignable<
  WireInitiativeProjectSummary,
  z.infer<typeof initiativeProjectSummarySchema>
>
type _readinessFwd = AssertAssignable<
  z.infer<typeof initiativeReadinessSchema>,
  WireInitiativeReadiness
>
type _readinessBack = AssertAssignable<
  WireInitiativeReadiness,
  z.infer<typeof initiativeReadinessSchema>
>
type _detailFwd = AssertAssignable<z.infer<typeof initiativeDetailSchema>, InitiativeDetailResponse>
type _detailBack = AssertAssignable<
  InitiativeDetailResponse,
  z.infer<typeof initiativeDetailSchema>
>

export type Initiative = WireInitiativeRecord
export type InitiativeStatus = WireInitiativeStatus
export type InitiativeReadiness = WireInitiativeReadiness
export type InitiativeBlocker = WireInitiativeBlocker
export type InitiativeProjectSummary = WireInitiativeProjectSummary
export type InitiativeDetail = InitiativeDetailResponse

export type __initiativeDriftGuard = [
  _initiativeFwd,
  _initiativeBack,
  _statusFwd,
  _statusBack,
  _blockerFwd,
  _blockerBack,
  _summaryFwd,
  _summaryBack,
  _readinessFwd,
  _readinessBack,
  _detailFwd,
  _detailBack,
]
