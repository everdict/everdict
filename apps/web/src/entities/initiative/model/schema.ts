import type {
  InitiativeBlocker as WireInitiativeBlocker,
  InitiativeProjectSummary as WireInitiativeProjectSummary,
  InitiativeReadiness as WireInitiativeReadiness,
  InitiativeRecord as WireInitiativeRecord,
  InitiativeStatus as WireInitiativeStatus,
  InitiativeUpdateRecord as WireInitiativeUpdateRecord,
} from '@everdict/contracts'
import type { InitiativeDetailResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

import { issueStatusSchema, trackerHistoryEntrySchema } from '@/entities/issue'
import { projectRollupSchema, projectStatusSchema } from '@/entities/project'
import { trackerHealthSchema } from '@/entities/tracker-health'

// The eval tracker's Initiative — 여러 프로젝트가 함께 향하는 **목표**(docs/tracker.md). 배포 단위가 아니다:
// 진척은 그 아래 전부를 훑은 산수이고, 완료가 게이트인 이유도 "열린 일이 남은 목표는 아직 이룬 게 아니다"
// 하나뿐이다. Runtime boundary validation stays here (zod v4); the EXPORTED types come from
// @everdict/contracts (`import type` only).

export const INITIATIVE_STATUSES = ['active', 'completed', 'cancelled'] as const
export const initiativeStatusSchema = z.enum(INITIATIVE_STATUSES)

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const initiativeSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: initiativeStatusSchema,
  // 상위 이니셔티브 — 진척은 하위까지 훑어 올라오므로, 큰 목표를 쪼개도 답은 하나로 남는다.
  parentId: z.string().optional(),
  // 이 목표를 책임지는 사람과, 그 사람이 마지막으로 올린 판정(health). 없음 = 아직 아무도 보고하지 않았다는
  // 뜻이고, 그건 "정상"과 다른 주장이다.
  lead: z.string().optional(),
  health: trackerHealthSchema.optional(),
  targetDate: calendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const initiativesSchema = z.array(initiativeSchema)

// 목표에 올라온 업데이트 한 건 — 추가만 되고 고쳐지지 않는다.
export const initiativeUpdateSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  initiativeId: z.string(),
  health: trackerHealthSchema,
  body: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
})
export const initiativeUpdatesSchema = z.array(initiativeUpdateSchema)

export const initiativeBlockerSchema = z.object({
  projectId: z.string().optional(),
  issueId: z.string(),
  // 이슈를 부르는 이름(`ENG-12`) — 남은 일 목록이 이슈를 다시 읽지 않고도 슬러그로 링크한다.
  identifier: z.string(),
  title: z.string(),
  status: issueStatusSchema,
})

export const initiativeProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  // 이 프로젝트를 실제로 품은 이니셔티브 — 없으면 이 이니셔티브 직속, 있으면 그 하위를 거쳐 올라온 것.
  viaInitiativeId: z.string().optional(),
  status: projectStatusSchema,
  // 목표 화면의 프로젝트 행이 프로젝트 목록과 같은 것을 말하도록 함께 실려 온다.
  health: trackerHealthSchema.optional(),
  lead: z.string().optional(),
  targetDate: calendarDateSchema.optional(),
  completedAt: z.string().optional(),
  rollup: projectRollupSchema,
})

// 목표가 얼마나 진행됐는지: `ready` 는 취소되지 않은 **모든** 프로젝트의 열린 이슈를 그 프로젝트 상태와
// 무관하게 센다 — 완료로 표시된 프로젝트라도 그 이슈가 나중에 회귀했다면 목표 아래에는 아직 일이 남아 있다.
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
type _updateFwd = AssertAssignable<
  z.infer<typeof initiativeUpdateSchema>,
  WireInitiativeUpdateRecord
>
type _updateBack = AssertAssignable<
  WireInitiativeUpdateRecord,
  z.infer<typeof initiativeUpdateSchema>
>

export type Initiative = WireInitiativeRecord
export type InitiativeUpdate = WireInitiativeUpdateRecord
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
  _updateFwd,
  _updateBack,
]
