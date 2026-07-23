import type { AgentSpec as ContractAgentSpec } from '@everdict/contracts'
import type {
  AgentListEntry,
  SaveAgentResult as ContractSaveAgentResult,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// 워크스페이스 에이전트(대화형 어시스턴트) 설정의 경계 검증은 여기 zod v4 에서만, EXPORT 타입은 @everdict/contracts 에 고정(P4).
// `import type` 만 — zod v3 wire 스키마는 웹에서 실행되지 않는다.

// 워크스페이스가 등록하는 MCP 도구 서버 — url + authSecret(시크릿 NAME, 값 아님) + write(옵트인: 켜면 mutating 도구까지 브리지).
export const agentMcpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  authSecret: z.string().optional(),
  write: z.boolean().default(false),
})
export type AgentMcpServer = z.infer<typeof agentMcpServerSchema>

// GET /agents/:id/versions/:version 200 — 전체 AgentSpec(instructions + MCP 도구서버 + model 오버라이드). 시크릿 값 없음.
export const agentSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  mcpServers: z.array(agentMcpServerSchema).default([]),
  model: z.string().optional(),
  tags: z.array(z.string()).default([]),
})
export type AgentSpec = z.infer<typeof agentSpecSchema>

// GET /agents 200 — 에이전트 id 당 한 항목(워크스페이스 소유 + _shared 폴백).
export const agentSummarySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()),
  owner: z.string(),
  createdBy: z.string().optional(),
})
export const agentsSchema = z.array(agentSummarySchema)
export type AgentSummary = z.infer<typeof agentSummarySchema>

// PUT /agents/:id 200 — 버전 없는 저장(업서트). created=false 면 기존 latest 와 동일해 새 버전 안 씀(멱등).
export const saveAgentResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  created: z.boolean(),
})
export type SaveAgentResult = z.infer<typeof saveAgentResultSchema>

// 드리프트 가드 — 요약은 wire 리스트 엔트리와 양방향; 스펙/저장결과는 web→contract 단방향(wire 계약이 SSOT).
type AssertAssignable<A extends B, B> = A
type _SummaryFwd = AssertAssignable<AgentSummary, AgentListEntry>
type _SummaryBack = AssertAssignable<AgentListEntry, AgentSummary>
type _SpecFwd = AssertAssignable<AgentSpec, ContractAgentSpec>
type _SaveFwd = AssertAssignable<SaveAgentResult, ContractSaveAgentResult>
type _SaveBack = AssertAssignable<ContractSaveAgentResult, SaveAgentResult>
