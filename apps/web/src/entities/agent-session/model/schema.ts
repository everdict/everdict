import type { AgentMessageRecord, AgentSessionRecord } from '@everdict/contracts'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the agent server's conversation records (docs/architecture/agent-conversations.md).

export const agentSessionSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  owner: z.string(),
  title: z.string(),
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
] as const
export const agentReferenceTypeSchema = z.enum(AGENT_REFERENCE_TYPES)
export type AgentReferenceType = z.infer<typeof agentReferenceTypeSchema>

export const agentReferenceSchema = z.object({
  type: agentReferenceTypeSchema,
  id: z.string(),
  version: z.string().optional(),
  label: z.string(),
})
export type AgentReference = z.infer<typeof agentReferenceSchema>

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
  toolCalls: z.array(agentToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  references: z.array(agentReferenceSchema).optional(),
  attachments: z.array(agentAttachmentSchema).optional(),
  createdAt: z.string(),
})

export const agentSessionListSchema = z.object({ sessions: z.array(agentSessionSchema) })
export const agentMessageListSchema = z.object({ messages: z.array(agentMessageSchema) })

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

export type __agentSessionDriftGuard = [_sessionFwd, _sessionBack, _messageFwd, _messageBack]
