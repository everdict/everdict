import type { AgentTaskRecord } from '@everdict/contracts'
import { z } from 'zod'

// 워크스페이스 태스크 원장(agent-teams) — 대화·에이전트를 넘는 조율 작업 단위. 경계 검증은 여기 zod v4,
// EXPORT 타입은 @everdict/contracts 에 고정(P4 드리프트 가드). `import type` 만.

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
  createdBy: z.string(),
  origin: z
    .object({ agentId: z.string().optional(), conversationId: z.string().optional() })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AgentTask = z.infer<typeof agentTaskSchema>
export const agentTaskListSchema = z.array(agentTaskSchema)

// 드리프트 가드 — 계약 레코드와 양방향(형태 동일 엔티티).
type AssertAssignable<A extends B, B> = A
type _TaskFwd = AssertAssignable<AgentTask, AgentTaskRecord>
type _TaskBack = AssertAssignable<AgentTaskRecord, AgentTask>
