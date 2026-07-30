import type {
  SkillRecord as ContractSkillRecord,
  SkillVersionRecord as ContractSkillVersionRecord,
} from '@everdict/contracts'
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
  verifiedVersion: z.string().optional(), // 시스템 소유 — verify 가 구간 [version, verifiedVersion]을 연장
})

// 스킬을 스토어에서 가져온 경우의 출처 — 사본이지 구독이 아니다(가져온 순간부터 워크스페이스가 소유·편집).
// 카탈로그가 "이미 가져간 예제"를 감추고, 상세가 "무엇에서 출발했는지"를 말하는 데만 쓰인다.
export const skillOriginSchema = z.object({
  source: z.string(), // 발행 워크스페이스("_everdict" = everdict 매니지드 예제)
  id: z.string(),
  version: z.string(),
  name: z.string(),
})
export type SkillOrigin = z.infer<typeof skillOriginSchema>

// GET /skills · /skills/:id — 전체 SkillRecord. visibility: private(개인 초안)|workspace(공유). instructions=SKILL.md 본문 + files=부속 파일.
// verifiedAt="아직 유효함" 마지막 확인 시각(updatedAt 과 별개 — 편집이 아님).
// version = 마지막으로 "찍은" 버전(행 자체는 작업본 — 편집은 자유롭고, 스탬프가 그 내용을 불변 버전으로 고정한다).
export const skillSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(skillFileSchema),
  refs: z.array(skillRefSchema).default([]),
  visibility: skillVisibilitySchema,
  version: z.string(),
  origin: skillOriginSchema.optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  verifiedAt: z.string().optional(),
})
export const skillsSchema = z.array(skillSchema)
export type Skill = z.infer<typeof skillSchema>

// GET /skills/:id/versions — 찍힌 버전들(최신 우선). 불변 스냅샷이라 예전 버전은 그때 말하던 그대로 남는다.
export const skillVersionSchema = z.object({
  skillId: z.string(),
  tenant: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.array(skillFileSchema),
  refs: z.array(skillRefSchema).default([]),
  note: z.string().optional(),
  stampedBy: z.string(),
  stampedAt: z.string(),
})
export const skillVersionsSchema = z.array(skillVersionSchema)
export type SkillVersion = z.infer<typeof skillVersionSchema>

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
type _VersionFwd = AssertAssignable<Omit<SkillVersion, 'refs'>, Omit<ContractSkillVersionRecord, 'refs'>>
type _VersionBack = AssertAssignable<ContractSkillVersionRecord, SkillVersion>
type _GenFwd = AssertAssignable<GenerateSkillResult, ContractGenerateSkillResult>
type _GenBack = AssertAssignable<ContractGenerateSkillResult, GenerateSkillResult>
