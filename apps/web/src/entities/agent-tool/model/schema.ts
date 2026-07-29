import type { AgentToolEntry as ContractAgentToolEntry } from '@everdict/contracts/wire'
import { z } from 'zod'

// 에이전트 도구 — "이 워크스페이스의 어시스턴트가 쓸 수 있는 도구"를 로그인한 멤버 기준으로 본 행.
// 워크스페이스 AgentSpec 이 공통 기준선(baseline)이고, 각 멤버가 그 위에 자기 on/off 를 얹는다(enabled).
// 경계 검증은 여기 zod v4 에서만, EXPORT 타입은 @everdict/contracts 고정(P4). `import type` 만.

// 도구가 어디서 왔는지 — 목록의 3개 섹션과 1:1.
export const agentToolScopeSchema = z.enum(['builtin', 'workspace', 'personal'])
export type AgentToolScope = z.infer<typeof agentToolScopeSchema>

export const agentToolEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(['mcp', 'code']),
  scope: agentToolScopeSchema,
  enabled: z.boolean(), // 나에게 적용되는 최종 상태
  baseline: z.boolean(), // 워크스페이스 기본값 — enabled 와 다르면 "내가 바꾼 것"
  writes: z.boolean(),
  requiredSecrets: z.array(z.string()),
  missingSecrets: z.array(z.string()),
  source: z.string().optional(),
  version: z.string().optional(),
  shadowedBy: z.string().optional(),
})
export type AgentToolEntry = z.infer<typeof agentToolEntrySchema>

export const agentToolListSchema = z.object({ tools: z.array(agentToolEntrySchema) })
export type AgentToolList = z.infer<typeof agentToolListSchema>

// 드리프트 가드 — 계약 wire 타입이 바뀌면 웹 타입체크가 깨진다(양방향).
type AssertAssignable<A extends B, B> = A
type _Fwd = AssertAssignable<AgentToolEntry, ContractAgentToolEntry>
type _Back = AssertAssignable<ContractAgentToolEntry, AgentToolEntry>
