import type { AgentMessageRecord, AgentPermissionMode } from '@everdict/contracts'
import type { AgentSessionResponse } from '@everdict/contracts/wire'
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
// suspended = stopped WITHOUT completing, resumably (a budget halt with its handoff, or an armed wait).
export const AGENT_RUN_STATUSES = [
  'running',
  'awaiting_approval',
  'suspended',
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
  // Computed by the agent service (never persisted): a chat turn is streaming RIGHT NOW — the panel re-attaches
  // to it (GET /stream) and the history menu shows the running badge.
  live: z.boolean().optional(),
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
  'knowledge', // a reified claim (get_knowledge_entry) — what the workspace learned, lineage included (supersedes/verifiedAt)
  'environment', // a capability of the environment kind (get_capability) — an evaluation environment image asset
  'tool', // a capability of the mcp|code kind (get_capability) — the tool the agent actually calls. source = the owning workspace
  'trace',
  'issue', // an eval tracker issue (get_issue) — the context of what is evaluated and why, how it closed and why it regressed
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

// The "mission" the conversation panel carries — entered through a domain detail's dedicated entry ("edit by conversation", etc.), it leaves
// the panel's STRUCTURE alone and frames only the empty screen's writing and suggestions for that work (the generic "analyze in conversation"
// entry has no mission = the default wording). The value is also a message catalog namespace (agentChat.missions.<kind>), so it is kept 1:1 with the catalog keys.
export const AGENT_CHAT_MISSIONS = [
  'skillEdit',
  'toolEdit',
  'harnessEdit',
  'datasetEdit',
  'judgeEdit',
  'runtimeEdit',
  'environmentEdit',
  'agentCraft',
  'viewAnalyze',
  'scorecardAnalyze',
  'runAnalyze',
  'issueAnalyze',
  'knowledgeAsk',
] as const
export const agentChatMissionSchema = z.enum(AGENT_CHAT_MISSIONS)
export type AgentChatMission = z.infer<typeof agentChatMissionSchema>

// The NATURE of a mission — it is what decides how the panel treats an entry. `edit` (a dedicated job editing an authored artifact) always
// starts a NEW conversation (there is never a reason to inherit somebody else's thread) and its default label becomes "edit by conversation".
// `analyze`/`ask` (entries that ASK about a result or knowledge) only drop a reference chip onto the open conversation — so as not to break the
// flow of comparing two scorecards in one conversation.
export const AGENT_CHAT_MISSION_INTENTS = {
  skillEdit: 'edit',
  toolEdit: 'edit',
  harnessEdit: 'edit',
  datasetEdit: 'edit',
  judgeEdit: 'edit',
  runtimeEdit: 'edit',
  environmentEdit: 'edit',
  agentCraft: 'edit',
  viewAnalyze: 'analyze',
  scorecardAnalyze: 'analyze',
  runAnalyze: 'analyze',
  issueAnalyze: 'analyze',
  knowledgeAsk: 'ask',
} as const satisfies Record<AgentChatMission, 'edit' | 'analyze' | 'ask'>
export type AgentChatMissionIntent = (typeof AGENT_CHAT_MISSION_INTENTS)[AgentChatMission]

// Whether this entry starts in a NEW conversation. Mission framing (the title, description and suggestions) appears only on an empty screen, so
// this decision IS "do you actually see a panel framed for the work every time you enter". An `edit` mission always does — editing an authored
// artifact has no reason to inherit somebody else's thread. `analyze`/`ask` only when the entry states `fresh`:
// the default is keeping the open thread (the flow of comparing two scorecards in one conversation), and an entry whose SUBJECT is this one
// record rather than whatever was open (an issue detail, an empty analysis canvas) declares that exception for itself.
export function startsFreshConversation(entry: {
  mission?: AgentChatMission
  fresh?: boolean
}): boolean {
  if (entry.fresh === true) return true
  return entry.mission !== undefined && AGENT_CHAT_MISSION_INTENTS[entry.mission] === 'edit'
}

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

// Drift guards — identical-shape entities (the web models every field and no extra), so each guard is
// bidirectional: a renamed/dropped/added field on EITHER side fails the web typecheck. The session anchors to
// the WIRE response (record + the computed `live` decoration), not the bare record — the web consumes responses.
type AssertAssignable<A extends B, B> = A
type WebAgentSession = z.infer<typeof agentSessionSchema>
type WebAgentMessage = z.infer<typeof agentMessageSchema>
type _sessionFwd = AssertAssignable<WebAgentSession, AgentSessionResponse>
type _sessionBack = AssertAssignable<AgentSessionResponse, WebAgentSession>
type _messageFwd = AssertAssignable<WebAgentMessage, AgentMessageRecord>
type _messageBack = AssertAssignable<AgentMessageRecord, WebAgentMessage>

// Exported names alias the contract types (consumers untouched: same identifiers).
export type AgentSession = AgentSessionResponse
export type AgentMessage = AgentMessageRecord
export type { AgentPermissionMode }

export type __agentSessionDriftGuard = [_sessionFwd, _sessionBack, _messageFwd, _messageBack]
