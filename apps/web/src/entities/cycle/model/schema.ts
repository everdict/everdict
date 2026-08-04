import type {
  CycleBurndown as WireCycleBurndown,
  CycleProgress as WireCycleProgress,
  CycleRecord as WireCycleRecord,
  CycleState as WireCycleState,
} from '@everdict/contracts'
import { z } from 'zod'

import { trackerHistoryEntrySchema } from '@/entities/issue'

// 트래커의 Cycle — 팀의 이터레이션(docs/tracker.md). 런타임 경계 검증은 여기(zod v4), EXPORT 타입은
// @everdict/contracts(타입 전용 import).

// 상태는 저장되지 않는다 — 날짜와 "명시적 종료"에서 파생된다. 종료일이 지났는데 아무도 닫지 않은 사이클은
// 완료가 아니라 잊힌 사이클이고, 목록은 그렇게 보여줘야 한다.
export const CYCLE_STATES = ['upcoming', 'active', 'completed'] as const
export const cycleStateSchema = z.enum(CYCLE_STATES)

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const cycleSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  teamId: z.string(),
  number: z.number(),
  name: z.string().optional(),
  description: z.string().optional(),
  startsAt: calendarDateSchema,
  endsAt: calendarDateSchema,
  completedAt: z.string().optional(),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const cyclesSchema = z.array(cycleSchema)

// 개수는 이슈를, 포인트는 추정치를 센다 — 추정 없는 이슈는 0포인트짜리 실제 작업이다.
export const cycleProgressSchema = z.object({
  total: z.number(),
  open: z.number(),
  done: z.number(),
  scope: z.number(),
  completedScope: z.number(),
  estimated: z.number(),
})

// 번다운 — 저장된 시계열이 아니라 이슈들의 이력을 되감아 만든 곡선이라 이슈와 어긋날 수가 없다. 두 가지
// 이력을 되감는다: 상태 변경(언제 끝났나)과 사이클 이동(언제 이 주기에 들어왔나). 그래서 중간에 끌어온 일은
// 도착한 날 스코프를 올린다 — "계획보다 덜 했다"와 "일이 더 들어왔다"는 다른 이야기다.
// 지나간 날만 그린다 — 오지 않은 날을 평평하게 이으면 "아무것도 안 했다"로 읽힌다.
export const cycleBurndownPointSchema = z.object({
  date: calendarDateSchema,
  scope: z.number(),
  remaining: z.number(),
  remainingIssues: z.number(),
})
export const cycleBurndownSchema = z.array(cycleBurndownPointSchema)

export const cycleDetailSchema = cycleSchema.extend({
  state: cycleStateSchema,
  progress: cycleProgressSchema,
  burndown: cycleBurndownSchema.default([]),
})

// 드리프트 가드 — 로컬 스키마와 와이어 계약이 상호 대입 가능해야 한다.
type AssertAssignable<A extends B, B> = A
type WebCycle = z.infer<typeof cycleSchema>
type _cycleFwd = AssertAssignable<WebCycle, WireCycleRecord>
type _cycleBack = AssertAssignable<WireCycleRecord, WebCycle>
type _stateFwd = AssertAssignable<z.infer<typeof cycleStateSchema>, WireCycleState>
type _stateBack = AssertAssignable<WireCycleState, z.infer<typeof cycleStateSchema>>
type _progressFwd = AssertAssignable<z.infer<typeof cycleProgressSchema>, WireCycleProgress>
type _progressBack = AssertAssignable<WireCycleProgress, z.infer<typeof cycleProgressSchema>>
type _burndownFwd = AssertAssignable<z.infer<typeof cycleBurndownSchema>, WireCycleBurndown>
type _burndownBack = AssertAssignable<WireCycleBurndown, z.infer<typeof cycleBurndownSchema>>

export type Cycle = WireCycleRecord
export type CycleState = WireCycleState
export type CycleProgress = WireCycleProgress
export type CycleBurndown = WireCycleBurndown
export type CycleDetail = z.infer<typeof cycleDetailSchema>

export type __cycleDriftGuard = [
  _cycleFwd,
  _cycleBack,
  _stateFwd,
  _stateBack,
  _progressFwd,
  _progressBack,
  _burndownFwd,
  _burndownBack,
]

// 사이클을 부르는 이름 — 대부분은 번호가 전부이고, 이름은 주제를 실은 것만 갖는다.
export function cycleLabel(cycle: { number: number; name?: string }): string {
  return cycle.name ?? `Cycle ${cycle.number}`
}
