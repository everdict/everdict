import type { SkillRecord as ContractSkillRecord } from '@everdict/contracts'
import type { GenerateSkillResult as ContractGenerateSkillResult } from '@everdict/contracts/wire'
import { z } from 'zod'

// 워크스페이스 스킬(멤버가 저작하는 SKILL.md식 절차) 경계 검증은 여기 zod v4 에서만, EXPORT 타입은 @everdict/contracts 고정(P4).
// `import type` 만 — zod v3 스키마는 웹에서 실행되지 않는다.

export const skillVisibilitySchema = z.enum(['private', 'workspace'])
export type SkillVisibility = z.infer<typeof skillVisibilitySchema>

// GET /skills · /skills/:id — 전체 SkillRecord. visibility: private(개인 초안)|workspace(공유). instructions=SKILL.md 본문.
export const skillSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  visibility: skillVisibilitySchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const skillsSchema = z.array(skillSchema)
export type Skill = z.infer<typeof skillSchema>

// POST /skills/generate 200 — AI 초안(skill-generate). 저장 전 편집용 드래프트, 영속 안 됨.
export const generateSkillResultSchema = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
})
export type GenerateSkillResult = z.infer<typeof generateSkillResultSchema>

// 드리프트 가드 — 레코드는 양방향(어느 쪽 필드 변경도 웹 타입체크를 깨뜨린다); 생성결과는 양방향(동일 형태).
type AssertAssignable<A extends B, B> = A
type _SkillFwd = AssertAssignable<Skill, ContractSkillRecord>
type _SkillBack = AssertAssignable<ContractSkillRecord, Skill>
type _GenFwd = AssertAssignable<GenerateSkillResult, ContractGenerateSkillResult>
type _GenBack = AssertAssignable<ContractGenerateSkillResult, GenerateSkillResult>
