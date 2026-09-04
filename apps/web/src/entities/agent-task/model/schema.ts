import type { AgentTaskRecord } from '@everdict/contracts'
import { z } from 'zod'

// The workspace task ledger (agent-teams) — the unit of coordination work that spans conversations and agents. Boundary validation is this zod v4,
// and the EXPORTED types are pinned to @everdict/contracts (the P4 drift guard). `import type` only.

export const agentTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>

export const agentTaskSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  subject: z.string(),
  description: z.string().optional(),
  status: agentTaskStatusSchema,
  owner: z.string().optional(),
  blockedBy: z.array(z.string()).default([]),
  output: z.string().optional(),
  createdBy: z.string(),
  origin: z
    .object({ agentId: z.string().optional(), conversationId: z.string().optional() })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AgentTask = z.infer<typeof agentTaskSchema>
export const agentTaskListSchema = z.array(agentTaskSchema)

// The drift guard — bidirectional with the contract record (an entity of identical shape).
type AssertAssignable<A extends B, B> = A
type _TaskFwd = AssertAssignable<AgentTask, AgentTaskRecord>
type _TaskBack = AssertAssignable<AgentTaskRecord, AgentTask>
