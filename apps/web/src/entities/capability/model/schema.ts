import type { CapabilityRecord as ContractCapabilityRecord } from '@everdict/contracts'
import { z } from 'zod'

// Capability Store — 멤버가 저작·발행하고 다른 멤버가 채택하는 하나의 판별자 엔티티(mcp|code|skill). 경계 검증은 여기 zod v4
// 에서만, EXPORT 타입은 @everdict/contracts 고정(P4). `import type` 만 — 계약의 zod v3 스키마는 웹에서 실행되지 않는다.

// 공개범위(reach) 4단계. subset=작성자 자기 워크스페이스들 중 일부(sharedWith), public=전체 노출(admin 게이트).
export const capabilityVisibilitySchema = z.enum(['private', 'workspace', 'subset', 'public'])
export type CapabilityVisibility = z.infer<typeof capabilityVisibilitySchema>

export const capabilityTypeSchema = z.enum(['mcp', 'code', 'skill'])
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

export const capabilitySpecSchema = z.discriminatedUnion('type', [
  mcpToolSpecSchema,
  codeToolSpecSchema,
  skillCapabilitySpecSchema,
])
export type CapabilitySpec = z.infer<typeof capabilitySpecSchema>

// GET /capabilities · /capabilities/public · /capabilities/:id — 전체 CapabilityRecord.
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
})
export const capabilitiesSchema = z.array(capabilitySchema)
export type Capability = z.infer<typeof capabilitySchema>

// PUT /capabilities/:id 200 — 저장 결과(할당된 버전).
export const saveCapabilityResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  created: z.boolean(),
})
export type SaveCapabilityResult = z.infer<typeof saveCapabilityResultSchema>

// 드리프트 가드 — 레코드는 양방향(어느 쪽 필드 변경도 웹 타입체크를 깨뜨린다).
type AssertAssignable<A extends B, B> = A
type _CapFwd = AssertAssignable<Capability, ContractCapabilityRecord>
type _CapBack = AssertAssignable<ContractCapabilityRecord, Capability>
