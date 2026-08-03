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

// 리니어의 여섯 상태를 우리 철자로 — `in_progress` 가 리니어의 "started" 다(이슈 어휘가 이미 그렇게 쓴다).
// `backlog`(아직 일정 없음)와 `paused`(버린 건 아니지만 멈춤)가 없으면 멈춘 프로젝트가 계속 진행 중으로 읽힌다.
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

// 프로젝트 안의 체크포인트. 순서가 곧 의미다(날짜로 가는 단계들).
export const projectMilestoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  targetDate: calendarDateSchema.optional(),
  sortOrder: z.number(),
})

// 올라온 업데이트 한 건 — 추가만 되고 고쳐지지 않는다.
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
  // 팀·이니셔티브 모두 N:M — 프로젝트는 여러 팀이 함께 하고, 여러 우산 아래 동시에 놓일 수 있다.
  // 팀은 제어 평면에서 최소 하나가 보장된다(팀 없는 프로젝트는 만들 수 없다). 여기서까지 min(1) 로 막지는
  // 않는다 — 읽는 쪽이고, 아직 마이그레이션되지 않은 배포의 옛 레코드 하나 때문에 화면을 통째로 못 그리는
  // 것보다 그려 주는 편이 낫다.
  teamIds: z.array(z.string()).default([]),
  initiativeIds: z.array(z.string()).default([]),
  // 책임자와 참여자. 그리고 가장 최근 업데이트의 health — 목록 행이 타임라인을 읽지 않고도 색을 낼 수 있게
  // 프로젝트에 얹혀 있다(없음 = 아무도 업데이트를 안 올림, "정상"과는 다르다).
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
