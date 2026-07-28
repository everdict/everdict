import type { SkillRecord as ContractSkillRecord } from '@everdict/contracts'
import type { GenerateSkillResult as ContractGenerateSkillResult } from '@everdict/contracts/wire'
import { z } from 'zod'

// 워크스페이스 스킬(멤버가 저작하는 SKILL.md식 절차) 경계 검증은 여기 zod v4 에서만, EXPORT 타입은 @everdict/contracts 고정(P4).
// `import type` 만 — zod v3 스키마는 웹에서 실행되지 않는다.

export const skillVisibilitySchema = z.enum(['private', 'workspace'])
export type SkillVisibility = z.infer<typeof skillVisibilitySchema>

// 스킬 부속 파일(claude-code references/* 재해석) — 본문은 슬림하게, 긴 참조자료는 파일로. 에이전트가 read_skill_file 로 온디맨드 로드.
export const skillFileSchema = z.object({
  path: z.string(),
  content: z.string(),
})
export type SkillFile = z.infer<typeof skillFileSchema>

// 스킬이 문서화하는 대상의 버전핀 참조({type,key,version?}) — staleness 계약(대상 버전이 넘어가면 스킬이 stale 로 표시).
// type 은 닫힌 NodeType vocabulary 지만 웹은 값 배열을 import 못 하므로 느슨한 string(드리프트 가드가 겹치는 필드를 잠금).
export const skillRefSchema = z.object({
  type: z.string(),
  key: z.string(),
  version: z.string().optional(),
})

// GET /skills · /skills/:id — 전체 SkillRecord. visibility: private(개인 초안)|workspace(공유). instructions=SKILL.md 본문 + files=부속 파일.
// verifiedAt="아직 유효함" 마지막 확인 시각(updatedAt 과 별개 — 편집이 아님).
export const skillSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(skillFileSchema),
  refs: z.array(skillRefSchema).default([]),
  visibility: skillVisibilitySchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  verifiedAt: z.string().optional(),
})
export const skillsSchema = z.array(skillSchema)
export type Skill = z.infer<typeof skillSchema>

// POST /skills/generate 200 — AI 초안(skill-generate). 저장 전 편집용 드래프트, 영속 안 됨.
export const generateSkillResultSchema = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(skillFileSchema),
})
export type GenerateSkillResult = z.infer<typeof generateSkillResultSchema>

// POST /agent/skills/try 200 — 스킬 테스트 드라이브 트랜스크립트(무상태, 영속 안 됨). assistant 본문 + tool호출(use_skill 포함).
export const skillTryMessageSchema = z.object({
  role: z.enum(['assistant', 'tool']),
  content: z.string(),
  toolCalls: z.array(z.object({ name: z.string(), arguments: z.string() })).optional(),
  toolCallId: z.string().optional(),
})
export const skillTryResultSchema = z.object({ messages: z.array(skillTryMessageSchema) })
export type SkillTryMessage = z.infer<typeof skillTryMessageSchema>
export type SkillTryResult = z.infer<typeof skillTryResultSchema>

// 드리프트 가드 — 레코드는 refs 제외 양방향(refs.type 은 의도적으로 느슨한 string 이라 계약→웹 단방향만 성립);
// 생성결과는 양방향(동일 형태).
type AssertAssignable<A extends B, B> = A
type _SkillFwd = AssertAssignable<Omit<Skill, 'refs'>, Omit<ContractSkillRecord, 'refs'>>
type _SkillBack = AssertAssignable<ContractSkillRecord, Skill>
type _GenFwd = AssertAssignable<GenerateSkillResult, ContractGenerateSkillResult>
type _GenBack = AssertAssignable<ContractGenerateSkillResult, GenerateSkillResult>
