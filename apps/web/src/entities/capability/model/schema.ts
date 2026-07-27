import type {
  CapabilityRecord as ContractCapabilityRecord,
  EnvironmentPreset,
} from '@everdict/contracts'
import { z } from 'zod'

// Capability Store — 멤버가 저작·발행하고 다른 멤버가 채택(도구 kind)하거나 하네스 저작에서 소비(environment)하는 하나의
// 판별자 엔티티(mcp|code|skill|environment). 경계 검증은 여기 zod v4 에서만, EXPORT 타입은 @everdict/contracts 고정(P4).
// `import type` 만 — 계약의 zod v3 스키마는 웹에서 실행되지 않는다.

// 공개범위(reach) 4단계. subset=작성자 자기 워크스페이스들 중 일부(sharedWith), public=전체 노출(admin 게이트).
export const capabilityVisibilitySchema = z.enum(['private', 'workspace', 'subset', 'public'])
export type CapabilityVisibility = z.infer<typeof capabilityVisibilitySchema>

export const capabilityTypeSchema = z.enum(['mcp', 'code', 'skill', 'environment'])
export type CapabilityType = z.infer<typeof capabilityTypeSchema>

// 채택자가 자기 시크릿으로 채워야 하는 값 — 이름 + 설명만(값 아님).
const requiredSecretSchema = z.object({ name: z.string(), description: z.string() })

// 판별자 spec — 한 capability 는 정확히 세 종류 중 하나.
const mcpToolSpecSchema = z.object({
  type: z.literal('mcp'),
  url: z.string(),
  provides: z.array(z.string()),
  requiredSecrets: z.array(requiredSecretSchema),
  write: z.boolean(),
})
const codeToolSpecSchema = z.object({
  type: z.literal('code'),
  language: z.enum(['python', 'node']),
  code: z.string(),
  parametersSchema: z.record(z.string(), z.unknown()),
  isReadOnly: z.boolean(),
  requiredSecrets: z.array(requiredSecretSchema),
  timeoutSec: z.number().optional(),
  image: z.string().optional(),
})
const skillCapabilitySpecSchema = z.object({ type: z.literal('skill'), instructions: z.string() })

// environment — 평가환경 이미지 자산(docs/architecture/environment-image-store.md). preset 은 깊은 토폴로지 서브어휘라
// 런타임은 shallow 체크만(컨트롤플레인이 실스키마로 검증·서빙, traceEvent passthrough 선례), 타입은 계약 앵커.
const environmentContentsSchema = z.object({
  benchmark: z.string().optional(),
  packages: z.array(z.string()),
  os: z.string().optional(),
  arch: z.string().optional(),
})
const environmentPresetSchema = z.custom<EnvironmentPreset>(
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
)
const environmentImageSpecSchema = z.object({
  type: z.literal('environment'),
  image: z.string(),
  contents: environmentContentsSchema.optional(),
  preset: environmentPresetSchema.optional(),
  instructions: z.string(),
})

export const capabilitySpecSchema = z.discriminatedUnion('type', [
  mcpToolSpecSchema,
  codeToolSpecSchema,
  skillCapabilitySpecSchema,
  environmentImageSpecSchema,
])
export type CapabilitySpec = z.infer<typeof capabilitySpecSchema>

// GET /capabilities · /capabilities/public · /capabilities/:id — 전체 CapabilityRecord
// + (environment kind 만) 뷰어 워크스페이스 레지스트리 기준 imageClass 주석(컨트롤플레인 계산·비영속, P1g 선례).
export const capabilityImageClassSchema = z.enum(['workspace', 'external', 'local', 'unqualified'])
export type CapabilityImageClass = z.infer<typeof capabilityImageClassSchema>
export const capabilitySchema = z.object({
  id: z.string(),
  tenant: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  spec: capabilitySpecSchema,
  visibility: capabilityVisibilitySchema,
  sharedWith: z.array(z.string()),
  tags: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.string(),
  imageClass: capabilityImageClassSchema.optional(),
})
export const capabilitiesSchema = z.array(capabilitySchema)
export type Capability = z.infer<typeof capabilitySchema>

// PUT /capabilities/:id 200 — 저장 결과(할당된 버전) + (environment) 이미지 분류 경고(warn-not-block).
export const saveCapabilityResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  created: z.boolean(),
  imageWarnings: z.array(z.object({ image: z.string(), class: z.string() })).optional(),
})
export type SaveCapabilityResult = z.infer<typeof saveCapabilityResultSchema>

// 드리프트 가드 — 레코드는 양방향(어느 쪽 필드 변경도 웹 타입체크를 깨뜨린다).
type AssertAssignable<A extends B, B> = A
type _CapFwd = AssertAssignable<Capability, ContractCapabilityRecord>
type _CapBack = AssertAssignable<ContractCapabilityRecord, Capability>
