import type {
  TeamMemberRecord as WireTeamMemberRecord,
  TeamRecord as WireTeamRecord,
  TeamSummary as WireTeamSummary,
} from '@everdict/contracts'
import { z } from 'zod'

import { trackerHistoryEntrySchema } from '@/entities/issue'

// 트래커의 Team — 워크스페이스 안에서 이슈를 소유하고 이름 붙이는 그룹(docs/tracker.md).
// 런타임 경계 검증은 여기(zod v4), EXPORT 타입은 @everdict/contracts(타입 전용 import).

// 식별자 접두사(`ENG-12`의 ENG). 생성 후 불변 — 이미 발행된 식별자에 박혀 있다.
export const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/

export const teamSummarySchema = z.object({
  memberCount: z.number(),
  openIssues: z.number(),
  totalIssues: z.number(),
})

export const teamSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().optional(),
  // 상위 팀 — 조직 표현일 뿐이다. 하위 팀도 자기 이슈를 소유하고 자기 식별자를 발번한다.
  parentId: z.string().optional(),
  isDefault: z.boolean(),
  // 팀의 이터레이션 주기(주). 스케줄이 아니라 다음 사이클을 제안할 때 쓰는 기본 폭이다.
  cycleDurationWeeks: z.number().default(2),
  // 들어오는 일이 워크플로 앞의 인박스에 먼저 앉는가. 기본은 꺼짐.
  triageEnabled: z.boolean().default(false),
  // 비공개 팀의 일은 로스터(그리고 워크스페이스 관리자)에게만 보인다. 권한 축이 아니라 가시성 필터다.
  isPrivate: z.boolean().default(false),
  issueCounter: z.number(),
  cycleCounter: z.number().default(0),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const teamsSchema = z.array(teamSchema)

// 목록/상세가 함께 받는 파생 요약 — 저장하지 않고 읽을 때 계산한다(ProjectRollup 과 같은 처리).
export const teamWithSummarySchema = teamSchema.extend({ summary: teamSummarySchema })
export const teamsWithSummarySchema = z.array(teamWithSummarySchema)

export const teamMemberSchema = z.object({
  tenant: z.string(),
  teamId: z.string(),
  subject: z.string(),
  addedBy: z.string(),
  addedAt: z.string(),
})
export const teamMembersSchema = z.array(teamMemberSchema)

// 드리프트 가드 — 로컬 스키마와 와이어 계약이 상호 대입 가능해야 한다(서버가 바뀌면 컴파일이 깨져 동시 수정을 강제).
type AssertAssignable<A extends B, B> = A
type WebTeam = z.infer<typeof teamSchema>
type _teamFwd = AssertAssignable<WebTeam, WireTeamRecord>
type _teamBack = AssertAssignable<WireTeamRecord, WebTeam>
type _summaryFwd = AssertAssignable<z.infer<typeof teamSummarySchema>, WireTeamSummary>
type _summaryBack = AssertAssignable<WireTeamSummary, z.infer<typeof teamSummarySchema>>
type _memberFwd = AssertAssignable<z.infer<typeof teamMemberSchema>, WireTeamMemberRecord>
type _memberBack = AssertAssignable<WireTeamMemberRecord, z.infer<typeof teamMemberSchema>>

export type Team = WireTeamRecord
export type TeamSummary = WireTeamSummary
export type TeamMember = WireTeamMemberRecord
export type TeamWithSummary = z.infer<typeof teamWithSummarySchema>

// 가드를 참조해 미사용 타입 린트가 제거하지 못하게 한다.
export type __teamDriftGuard = [
  _teamFwd,
  _teamBack,
  _summaryFwd,
  _summaryBack,
  _memberFwd,
  _memberBack,
]
