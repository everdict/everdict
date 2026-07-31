import type {
  ProjectRecord as WireProjectRecord,
  ProjectRollup as WireProjectRollup,
  ProjectStatus as WireProjectStatus,
} from '@everdict/contracts'
import type { ProjectDetailResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

import { trackerHistoryEntrySchema } from '@/entities/issue'

// The eval tracker's Project — issues under one target date (docs/tracker.md). Runtime boundary validation
// stays here (zod v4); the EXPORTED types come from @everdict/contracts (`import type` only).

export const PROJECT_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'] as const
export const projectStatusSchema = z.enum(PROJECT_STATUSES)

// Calendar dates, not instants — the literal YYYY-MM-DD round-trips with no timezone reinterpretation.
const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const projectSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: projectStatusSchema,
  initiativeId: z.string().optional(),
  targetDate: calendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const projectsSchema = z.array(projectSchema)

// Derived on the detail read, never stored (the ScorecardRecord.trialSummary precedent). `evaluated` is the
// stricter claim than `done`: closed WITH a scorecard, which is what a release conversation asks about.
export const projectRollupSchema = z.object({
  total: z.number(),
  open: z.number(),
  done: z.number(),
  cancelled: z.number(),
  // The server fills EVERY status key (readiness.ts seeds the map from ISSUE_STATUSES), so consumers never
  // branch on undefined. Keyed by plain string rather than the status enum because zod v4 types an
  // enum-keyed record as Partial — the status vocabulary itself is guarded by issueStatusSchema.
  byStatus: z.record(z.string(), z.number()),
  evaluated: z.number(),
  ready: z.boolean(),
})

export const projectDetailSchema = projectSchema.extend({ rollup: projectRollupSchema })

// Drift guard — mutually assignable with the wire contract in both directions.
type AssertAssignable<A extends B, B> = A
type WebProject = z.infer<typeof projectSchema>
type _projectFwd = AssertAssignable<WebProject, WireProjectRecord>
type _projectBack = AssertAssignable<WireProjectRecord, WebProject>
type _statusFwd = AssertAssignable<z.infer<typeof projectStatusSchema>, WireProjectStatus>
type _statusBack = AssertAssignable<WireProjectStatus, z.infer<typeof projectStatusSchema>>
type _rollupFwd = AssertAssignable<z.infer<typeof projectRollupSchema>, WireProjectRollup>
type _rollupBack = AssertAssignable<WireProjectRollup, z.infer<typeof projectRollupSchema>>
type _detailFwd = AssertAssignable<z.infer<typeof projectDetailSchema>, ProjectDetailResponse>
type _detailBack = AssertAssignable<ProjectDetailResponse, z.infer<typeof projectDetailSchema>>

export type Project = WireProjectRecord
export type ProjectStatus = WireProjectStatus
export type ProjectRollup = WireProjectRollup
export type ProjectDetail = ProjectDetailResponse

export type __projectDriftGuard = [
  _projectFwd,
  _projectBack,
  _statusFwd,
  _statusBack,
  _rollupFwd,
  _rollupBack,
  _detailFwd,
  _detailBack,
]
