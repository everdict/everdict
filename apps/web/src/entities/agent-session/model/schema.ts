import type {
  AgentMessageRecord,
  AgentPermissionMode,
  AgentSessionRecord,
} from '@everdict/contracts'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the agent server's conversation records (docs/architecture/agent-conversations.md).

// How the conversation's mutating tool calls are approved (the member's standing pick in the chat header):
// default = ask every time · auto = ask only destructive/governance actions · bypass = never ask · plan = read-only
// until the agent's plan is approved.
export const AGENT_PERMISSION_MODES = ['default', 'auto', 'bypass', 'plan'] as const
export const agentPermissionModeSchema = z.enum(AGENT_PERMISSION_MODES)

// What started a session (agent-automation A3/A4) — trigger runs pin the crafted agent + the waking event.
export const AGENT_SESSION_ORIGIN_TYPES = [
  'chat',
  'discussion',
  'teammate',
  'trigger',
  'schedule',
  'api',
] as const
export const agentSessionOriginSchema = z.object({
  type: z.enum(AGENT_SESSION_ORIGIN_TYPES),
  agentId: z.string().optional(),
  agentVersion: z.string().optional(),
  eventId: z.string().optional(),
  eventKind: z.string().optional(),
})
export type AgentSessionOrigin = z.infer<typeof agentSessionOriginSchema>

// A headless run's lifecycle (the fleet view's status chip). Plain conversations have none.
export const AGENT_RUN_STATUSES = [
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const
export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES)
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>

export const agentSessionSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  owner: z.string(),
  title: z.string(),
  // Registered model id this conversation runs on (the member's per-conversation pick); unset → workspace/server default.
  model: z.string().optional(),
  // The session's standing permission mode; unset → "default" (ask for every mutation).
  permissionMode: agentPermissionModeSchema.optional(),
  // Who may read/continue: unset|"private" = owner only; "workspace" = any member (a comment thread's discussion session).
  visibility: z.enum(['private', 'workspace']).optional(),
  // What started the session (unset = legacy/chat); trigger runs carry agentId@version + the waking event.
  origin: agentSessionOriginSchema.optional(),
  // Headless-run lifecycle status (unset for plain conversations).
  status: agentRunStatusSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const agentToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
})

export const AGENT_REFERENCE_TYPES = [
  'harness',
  'runtime',
  'run',
  'dataset',
  'scorecard',
  'judge',
  'view',
  'skill',
  'knowledge', // reified claim(get_knowledge_entry) — 워크스페이스가 배운 것, 계보(supersedes/verifiedAt) 포함
  'environment', // environment kind 의 capability(get_capability) — 평가 환경 이미지 자산
  'tool', // mcp|code kind 의 capability(get_capability) — 에이전트가 실제로 호출하는 도구. source=소유 워크스페이스
  'trace',
] as const
export const agentReferenceTypeSchema = z.enum(AGENT_REFERENCE_TYPES)
export type AgentReferenceType = z.infer<typeof agentReferenceTypeSchema>

// `source` carries the OWNER for the two references that can live outside this workspace: a `trace` (the registered
// trace-source name it lives in, keyed by (source, id=traceId) and attached from the observability browser rather
// than the @-picker) and a `tool` (the workspace that published the capability — a first-party default is
// `_everdict`-owned).
export const agentReferenceSchema = z.object({
  type: agentReferenceTypeSchema,
  id: z.string(),
  version: z.string().optional(),
  label: z.string(),
  source: z.string().optional(),
})
export type AgentReference = z.infer<typeof agentReferenceSchema>

// 대화 패널에 실리는 "임무" — 특정 도메인 상세의 전용 진입("대화로 편집하기" 등)으로 들어왔을 때, 패널의 구조는
// 그대로 두고 빈 화면의 라이팅과 제안만 그 작업에 맞춘다(범용 "대화에서 분석" 진입은 임무 없음 = 기본 문구).
// 값은 메시지 카탈로그 네임스페이스(agentChat.missions.<kind>)이기도 하므로 카탈로그 키와 1:1로 유지한다.
export const AGENT_CHAT_MISSIONS = ['skillEdit', 'toolEdit'] as const
export const agentChatMissionSchema = z.enum(AGENT_CHAT_MISSIONS)
export type AgentChatMission = z.infer<typeof agentChatMissionSchema>

export const agentAttachmentSchema = z.object({
  name: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
})
export type AgentAttachment = z.infer<typeof agentAttachmentSchema>

// The composer's in-flight attachment — carries the read text content sent to the agent (not persisted).
export interface AgentAttachmentInput {
  name: string
  mimeType?: string
  size?: number
  content?: string
}

export const agentMessageSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  sessionId: z.string(),
  seq: z.number(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  // assistant turns: the model's reasoning / extended-thinking for this turn (display text only). Absent when the
  // model produced no reasoning.
  reasoning: z.string().optional(),
  toolCalls: z.array(agentToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  references: z.array(agentReferenceSchema).optional(),
  attachments: z.array(agentAttachmentSchema).optional(),
  createdAt: z.string(),
})

export const agentSessionListSchema = z.object({ sessions: z.array(agentSessionSchema) })

// A teammate — a long-lived autonomous agent the member spawns (docs/architecture/agent-teams.md). It watches
// platform event kinds and wakes to react (proactive team). An agent-server concept with no control-plane record,
// so the type is local (no @everdict/contracts anchor).
export const AGENT_EVENT_KINDS = [
  'run.completed',
  'run.failed',
  'scorecard.completed',
  'scorecard.failed',
] as const
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number]

export const agentTeammateSchema = z.object({
  id: z.string(),
  name: z.string(),
  watch: z.array(z.string()),
})
export type AgentTeammate = z.infer<typeof agentTeammateSchema>
export const agentTeammateListSchema = z.object({ teammates: z.array(agentTeammateSchema) })
export const agentMessageListSchema = z.object({ messages: z.array(agentMessageSchema) })
// Fleet view (agent-automation A5): every agent RUN in the workspace (sessions with an origin), newest first.
export const agentRunListSchema = z.object({ runs: z.array(agentSessionSchema) })

// Drift guards — identical-shape entities (the web models every record field and no extra), so each guard is
// bidirectional: a renamed/dropped/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebAgentSession = z.infer<typeof agentSessionSchema>
type WebAgentMessage = z.infer<typeof agentMessageSchema>
type _sessionFwd = AssertAssignable<WebAgentSession, AgentSessionRecord>
type _sessionBack = AssertAssignable<AgentSessionRecord, WebAgentSession>
type _messageFwd = AssertAssignable<WebAgentMessage, AgentMessageRecord>
type _messageBack = AssertAssignable<AgentMessageRecord, WebAgentMessage>

// Exported names alias the contract types (consumers untouched: same identifiers).
export type AgentSession = AgentSessionRecord
export type AgentMessage = AgentMessageRecord
export type { AgentPermissionMode }

export type __agentSessionDriftGuard = [_sessionFwd, _sessionBack, _messageFwd, _messageBack]
