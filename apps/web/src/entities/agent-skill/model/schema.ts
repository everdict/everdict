import type { AgentSkillEntry as ContractAgentSkillEntry } from '@everdict/contracts/wire'
import { z } from 'zod'

// 에이전트 스킬 — "이 워크스페이스가 지원하는 절차"를 로그인한 멤버 기준으로 본 행.
// 워크스페이스 스킬 라이브러리(워크스페이스가 소유한 Skill 레코드 — 직접 쓴 것 + 스토어에서 가져온 사본)가
// 기준선이고, 각 멤버가 그 위에 자기 on/off 를 얹는다.
// 경계 검증은 여기 zod v4 에서만, EXPORT 타입은 @everdict/contracts 고정(P4). `import type` 만.
import { agentToolScopeSchema } from '@/entities/agent-tool'

export const agentSkillEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  scope: agentToolScopeSchema,
  enabled: z.boolean(), // 나에게 적용되는 최종 상태
  baseline: z.boolean(), // 워크스페이스 기본값 — enabled 와 다르면 "내가 바꾼 것"
  version: z.string().optional(),
  shadowedBy: z.string().optional(),
})
export type AgentSkillEntry = z.infer<typeof agentSkillEntrySchema>

export const agentSkillListSchema = z.object({ skills: z.array(agentSkillEntrySchema) })
export type AgentSkillList = z.infer<typeof agentSkillListSchema>

// 드리프트 가드 — 계약 wire 타입이 바뀌면 웹 타입체크가 깨진다(양방향).
type AssertAssignable<A extends B, B> = A
type _Fwd = AssertAssignable<AgentSkillEntry, ContractAgentSkillEntry>
type _Back = AssertAssignable<ContractAgentSkillEntry, AgentSkillEntry>
