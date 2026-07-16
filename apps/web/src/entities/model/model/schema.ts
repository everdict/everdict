import type { ModelSpec as ContractModelSpec } from '@everdict/contracts'
import type { ModelListEntry } from '@everdict/contracts/wire'
import { z } from 'zod'

// 모델(추론/판정용 LLM) 경계 검증은 여기 zod v4 에서만 하고, EXPORT 타입은 @everdict/contracts 에 고정(재아키텍처 P4).
// `import type` 만 — zod v3 wire 스키마는 웹에서 실행되지 않는다.

// GET /models 200 — 모델 id 당 한 항목(워크스페이스 소유 + _shared 폴백).
// createdBy = 최초 등록 버전의 등록자 subject(seed/_shared 는 없음) — 누가 삭제할 수 있는지(등록자-or-admin) 판단용.
export const modelSummarySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()),
  owner: z.string(),
  createdBy: z.string().optional(),
})
export const modelsSchema = z.array(modelSummarySchema)
export type ModelSummary = z.infer<typeof modelSummarySchema>

// GET /models/:id/versions/:version 200 — 전체 ModelSpec. provider 연결정보 + apiKeySecret(시크릿 NAME, 값 아님).
// apiKeySecret 은 하네스의 에이전트 서버/저지가 이 모델을 쓸 때 연결할 워크스페이스 SecretStore 키 이름 — 값은 디스패치 직전 해석.
export const modelSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  provider: z.enum(['anthropic', 'openai']),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKeySecret: z.string().optional(),
  params: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
})
export type ModelSpec = z.infer<typeof modelSpecSchema>

// 드리프트 가드 — 요약은 wire 리스트 엔트리와 동일 형태라 양방향(어느 쪽 필드 변경도 웹 타입체크를 깨뜨린다);
// 스펙은 web→contract 단방향(웹은 표시/등록만, wire 계약이 SSOT).
type AssertAssignable<A extends B, B> = A
type _SummaryFwd = AssertAssignable<ModelSummary, ModelListEntry>
type _SummaryBack = AssertAssignable<ModelListEntry, ModelSummary>
type _SpecFwd = AssertAssignable<ModelSpec, ContractModelSpec>
