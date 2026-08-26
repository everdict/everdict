import type { AgentSpec as ContractAgentSpec } from '@everdict/contracts'
import type {
  AgentListEntry,
  SaveAgentResult as ContractSaveAgentResult,
} from '@everdict/contracts/wire'
import { z } from 'zod'

import { versionOriginsSchema } from '@/entities/capability-origin'

// 워크스페이스 에이전트(대화형 어시스턴트) 설정의 경계 검증은 여기 zod v4 에서만, EXPORT 타입은 @everdict/contracts 에 고정(P4).
// `import type` 만 — zod v3 wire 스키마는 웹에서 실행되지 않는다.

// 워크스페이스가 등록하는 MCP 도구 서버 — url + authSecret(시크릿 NAME, 값 아님) + write(옵트인: 켜면 mutating 도구까지 브리지).
export const agentMcpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  authSecret: z.string().optional(),
  write: z.boolean().default(false),
})
export type AgentMcpServer = z.infer<typeof agentMcpServerSchema>

// 스토어에서 채택한 capability 참조(불변버전 pin). source=발행 워크스페이스(내 것이면 내 tenant), secretBindings=필요시크릿→내 시크릿 이름.
export const capabilityRefSchema = z.object({
  source: z.string(),
  id: z.string(),
  version: z.string(),
  secretBindings: z.record(z.string(), z.string()).default({}),
  enableWrite: z.boolean().default(false),
})
export type CapabilityRef = z.infer<typeof capabilityRefSchema>

// 트리거 구독 가능한 플랫폼 이벤트 kind — agent.run.* 라이프사이클 사실은 제외(에이전트가 에이전트를 보는 폭주 벡터 차단).
export const TRIGGERABLE_EVENT_KINDS = [
  'run.submitted',
  'run.completed',
  'run.failed',
  'scorecard.submitted',
  'scorecard.case.completed',
  'scorecard.completed',
  'scorecard.failed',
  'scorecard.cancelled',
  'report.completed',
  'comment.created',
  // E2 coverage (event-plumbing.md §3) — content/registry, fs, knowledge, and ops facts are automation hooks too (same vocabulary as the server list).
  'harness.registered',
  'dataset.registered',
  'judge.registered',
  'file.published',
  'knowledge.created',
  'knowledge.proposed',
  'knowledge.approved',
  'budget.exceeded',
  'schedule.fired',
  'trace.threshold_crossed',
  'trace.ingestion_throttled',
  // M2 라이브 이상 팩트 — 배치 불가/런타임 서킷 오픈(서버 목록과 동일 어휘)
  'run.placement_blocked',
  'runtime.circuit_opened',
  // Task ledger (agent-teams) — "new work appeared" / "a dependency cleared" (same vocabulary as the server list).
  'task.created',
  'task.completed',
  // Eval tracker (docs/tracker.md) — the "why" layer's wake signals: a new issue landed, an issue regressed
  // (payload filter cause eq regression), a project/initiative closed. Same vocabulary as the server list.
  'issue.created',
  'issue.status_changed',
  'project.status_changed',
  'project.update_posted',
  'initiative.status_changed',
  // 목표가 흔들렸다 — 같은 payload 필터(health eq off_track)를, 이해관계자가 읽는 목표 쪽 업데이트에.
  'initiative.update_posted',
  // 이터레이션이 닫혔다 — 회고 요약을 쓰라는 신호. 사이클은 한 번 닫히므로 한 번만 깨운다.
  'cycle.completed',
  // Product timeline (docs/architecture/product-timeline.md) — a tracked service released / a release was
  // planned / we shipped (payload filter: to eq released). Same vocabulary as the server list.
  'product.service_version_imported',
  'release.created',
  'release.status_changed',
] as const

// 이벤트 payload 에 대한 선언적 필터 하나 — filters 는 AND 결합(예: passRate < 1 = 실패 케이스 있는 배치).
export const agentTriggerFilterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'exists']),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
})
export const agentTriggerSchema = z.object({
  kinds: z.array(z.enum(TRIGGERABLE_EVENT_KINDS)).min(1),
  filters: z.array(agentTriggerFilterSchema).default([]),
})
export type AgentTrigger = z.infer<typeof agentTriggerSchema>

// 세션 권한 모드 — agent-session 엔티티와 같은 어휘(default=매번 확인 · auto · bypass · plan).
export const agentSpecPermissionModeSchema = z.enum(['default', 'auto', 'bypass', 'plan'])

// 크래프팅 캔버스의 draft 어휘(agent-automation B2/B3) — 대화가 craft_agent 로 패치하는 AgentSpec 부분집합.
// 챗 턴마다 body.agentDraft 로 실려 가고, SSE `agent_draft` 로 돌아온다.
export const agentDraftSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  task: z.string().optional(),
  triggers: z.array(agentTriggerSchema).optional(),
  permissionMode: agentSpecPermissionModeSchema.optional(),
  model: z.string().optional(),
})
export type AgentDraft = z.infer<typeof agentDraftSchema>

// GET /agents/:id/versions/:version 200 — 전체 AgentSpec(instructions + MCP 도구서버 + 채택 capability + model 오버라이드
// + 트리거/상시 task/권한모드/활성화 — agent-automation A3). 시크릿 값 없음.
export const agentSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  mcpServers: z.array(agentMcpServerSchema).default([]),
  capabilities: z.array(capabilityRefSchema).default([]),
  // 워크스페이스가 끈 first-party 기본 도구(capability id) — 기본 도구셋(웹검색 등)은 채택 없이 붙지만 여기 나열한 id 는 제외.
  disabledDefaults: z.array(z.string()).default([]),
  // 자기 바인딩 저장처가 없는 도구(기본 제공·미채택 발행물)의 시크릿 리매핑 — 도구 키 → { 선언 이름 → 실제 시크릿 이름 }.
  // 값은 절대 없다(이름만). 저장 시 반드시 보존(capabilities/disabledDefaults 와 동일 규칙).
  toolSecretBindings: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  model: z.string().optional(),
  // 트리거 활성화 시 첫 메시지로 렌더되는 상시 지시(매 턴을 물들이는 instructions 와 구분).
  task: z.string().optional(),
  triggers: z.array(agentTriggerSchema).default([]),
  // 이 에이전트의 헤드리스 런 기본 권한 모드(챗 세션의 자체 모드가 대화별로 우선).
  permissionMode: agentSpecPermissionModeSchema.optional(),
  // 활성화 옵트인 — enabled 인 에이전트만 트리거 매칭 대상.
  enabled: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
})
export type AgentSpec = z.infer<typeof agentSpecSchema>

// GET /agents/defaults 200 — 빌트인(first-party) 기본 도구 카탈로그. 토글 렌더용 읽기 전용 형태(계약 wire 타입 없음 → 드리프트 가드 없음).
export const agentDefaultSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  requires: z.string().nullish(),
})
export type AgentDefault = z.infer<typeof agentDefaultSchema>
export const agentDefaultsSchema = z.object({ defaults: z.array(agentDefaultSchema) })

// GET /agents 200 — 에이전트 id 당 한 항목(워크스페이스 소유 + _shared 폴백).
// teamId/versionOrigins 는 다른 레지스트리 목록과 같은 팀·리니지 한 줄 — 파서가 벗겨내면 목록이 팀 축과
// "이 버전이 왜 존재하나"를 그릴 수 없다(review wave C).
export const agentSummarySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()),
  owner: z.string(),
  createdBy: z.string().optional(),
  teamId: z.string().optional(),
  versionOrigins: versionOriginsSchema.optional(),
})
export const agentsSchema = z.array(agentSummarySchema)
export type AgentSummary = z.infer<typeof agentSummarySchema>

// PUT /agents/:id 200 — 버전 없는 저장(업서트). created=false 면 기존 latest 와 동일해 새 버전 안 씀(멱등).
export const saveAgentResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  created: z.boolean(),
})
export type SaveAgentResult = z.infer<typeof saveAgentResultSchema>

// 드리프트 가드 — 요약은 wire 리스트 엔트리와 양방향; 스펙/저장결과는 web→contract 단방향(wire 계약이 SSOT).
type AssertAssignable<A extends B, B> = A
type _SummaryFwd = AssertAssignable<AgentSummary, AgentListEntry>
type _SummaryBack = AssertAssignable<AgentListEntry, AgentSummary>
type _SpecFwd = AssertAssignable<AgentSpec, ContractAgentSpec>
type _SaveFwd = AssertAssignable<SaveAgentResult, ContractSaveAgentResult>
type _SaveBack = AssertAssignable<ContractSaveAgentResult, SaveAgentResult>
