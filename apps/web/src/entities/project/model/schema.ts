import type {
  ProjectMilestone as WireProjectMilestone,
  ProjectRecord as WireProjectRecord,
  ProjectRollup as WireProjectRollup,
  ProjectStatus as WireProjectStatus,
  ProjectUpdateRecord as WireProjectUpdateRecord,
} from '@everdict/contracts'
import type { ProjectDetailResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

import { trackerHistoryEntrySchema } from '@/entities/issue'
import { trackerHealthSchema } from '@/entities/tracker-health'

// The eval tracker's Project — issues under one target date (docs/tracker.md). Runtime boundary validation
// stays here (zod v4); the EXPORTED types come from @everdict/contracts (`import type` only).

// Linear's six states in our spelling — `in_progress` is Linear's "started" (the issue vocabulary already writes it that way).
// Without `backlog` (not scheduled yet) and `paused` (not abandoned but stopped), a stalled project keeps reading as in progress.
export const PROJECT_STATUSES = [
  'backlog',
  'planned',
  'in_progress',
  'paused',
  'completed',
  'cancelled',
] as const
export const projectStatusSchema = z.enum(PROJECT_STATUSES)

// Calendar dates, not instants — the literal YYYY-MM-DD round-trips with no timezone reinterpretation.
const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

// A checkpoint inside a project. Its ORDER is the meaning (the steps toward a date).
export const projectMilestoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  targetDate: calendarDateSchema.optional(),
  sortOrder: z.number(),
})

// One posted update — append-only, never edited.
export const projectUpdateSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  projectId: z.string(),
  health: trackerHealthSchema,
  body: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
})
export const projectUpdatesSchema = z.array(projectUpdateSchema)

export const projectSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: projectStatusSchema,
  // Teams and initiatives are both N:M — a project is worked by several teams and can sit under several umbrellas at once.
  // At least one team is guaranteed by the control plane (a project cannot be created with none). It is deliberately not enforced with min(1)
  // here — this is the READING side, and drawing is better than failing to draw a whole screen over one old record on a deployment that has
  // not migrated yet.
  initiativeIds: z.array(z.string()).default([]),
  // The lead and the participants. And the health of the most recent update — carried on the project so a list row can take its colour without
  // reading the timeline (absent = nobody posted an update, which is different from "fine").
  lead: z.string().optional(),
  memberIds: z.array(z.string()).default([]),
  health: trackerHealthSchema.optional(),
  milestones: z.array(projectMilestoneSchema).default([]),
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
type _milestoneFwd = AssertAssignable<z.infer<typeof projectMilestoneSchema>, WireProjectMilestone>
type _milestoneBack = AssertAssignable<WireProjectMilestone, z.infer<typeof projectMilestoneSchema>>
type _updateFwd = AssertAssignable<z.infer<typeof projectUpdateSchema>, WireProjectUpdateRecord>
type _updateBack = AssertAssignable<WireProjectUpdateRecord, z.infer<typeof projectUpdateSchema>>
type _detailFwd = AssertAssignable<z.infer<typeof projectDetailSchema>, ProjectDetailResponse>
type _detailBack = AssertAssignable<ProjectDetailResponse, z.infer<typeof projectDetailSchema>>

export type ProjectMilestone = WireProjectMilestone
export type ProjectUpdate = WireProjectUpdateRecord
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
  _milestoneFwd,
  _milestoneBack,
  _updateFwd,
  _updateBack,
]
