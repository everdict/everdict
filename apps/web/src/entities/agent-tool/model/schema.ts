import type {
  AgentModelPreferenceResponse as ContractAgentModelPreference,
  AgentToolDetailResponse as ContractAgentToolDetail,
  AgentToolEntry as ContractAgentToolEntry,
  AgentToolFunction as ContractAgentToolFunction,
  AgentToolProbeResponse as ContractAgentToolProbe,
} from '@everdict/contracts/wire'
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

// ── 상세 ─────────────────────────────────────────────────────────────────────────────────────────
// 목록 행이 "켤까 말까"라면 상세는 "이게 뭔가"다: 어떻게 도달하고, 모델 앞에 어떤 function 을 놓고, 모델이 읽는
// description 이 뭐고, 어떤 시크릿을 필요로 하며 그게 나에게 풀리는가.

// 모델이 실제로 부르는 이름은 네임스페이스된 bridgedName 이다(스토어 이름이 아니라) — 두 서버가 이름으로 충돌하지
// 않게 런타임이 붙인다.
export const agentToolFunctionSchema = z.object({
  name: z.string(),
  bridgedName: z.string(),
  description: z.string(),
  parametersSchema: z.record(z.string(), z.unknown()).optional(),
  readOnly: z.boolean(),
})
export type AgentToolFunction = z.infer<typeof agentToolFunctionSchema>

// 런타임이 이 도구에 도달하는 방식 — 원격 MCP 세션 / stdio 컨테이너 / 코드 스크립트.
export const agentToolTransportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http'), url: z.string() }),
  z.object({ kind: z.literal('stdio'), image: z.string(), args: z.array(z.string()) }),
  z.object({
    kind: z.literal('code'),
    language: z.enum(['python', 'node']),
    timeoutSec: z.number().optional(),
    image: z.string().optional(),
  }),
])
export type AgentToolTransport = z.infer<typeof agentToolTransportSchema>

// 선언된 시크릿 하나를 "나" 기준으로 본 것 — 도구가 부르는 논리 이름, 실제로 읽는 시크릿 이름, 내가 가진 것인지.
export const agentToolSecretSchema = z.object({
  name: z.string(),
  description: z.string(),
  boundTo: z.string(),
  resolved: z.boolean(),
})
export type AgentToolSecret = z.infer<typeof agentToolSecretSchema>

export const agentToolExampleSchema = z.object({
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  note: z.string().optional(),
})

export const agentToolDetailSchema = agentToolEntrySchema.extend({
  origin: z.enum(['builtin', 'capability', 'mcpServer']),
  transport: agentToolTransportSchema,
  functions: z.array(agentToolFunctionSchema),
  secrets: z.array(agentToolSecretSchema),
  code: z.string().optional(), // code 도구의 고정된 소스 — 무엇이 실행되는지 감사 가능
  parametersSchema: z.record(z.string(), z.unknown()).optional(),
  examples: z.array(agentToolExampleSchema),
  capability: z.object({ source: z.string(), id: z.string(), version: z.string() }).optional(),
  tags: z.array(z.string()),
  bindable: z.boolean(), // 시크릿 바인딩을 여기서 바꿀 수 있는가(채택된 capability · 직접 배선한 MCP 서버)
  editable: z.boolean(), // 대화로 편집 + 버전업 가능한가(이 워크스페이스가 소유한 capability만)
  probeable: z.boolean(), // 연결 테스트가 의미 있는가(원격 HTTP MCP 만)
})
export type AgentToolDetail = z.infer<typeof agentToolDetailSchema>

export const agentToolProbeSchema = z.object({
  reachable: z.boolean(),
  detail: z.string(),
  reason: z.enum(['auth', 'unreachable', 'protocol']).optional(),
  functions: z.array(agentToolFunctionSchema),
  missingSecrets: z.array(z.string()),
})
export type AgentToolProbe = z.infer<typeof agentToolProbeSchema>

// ── 내 기본 모델 ──────────────────────────────────────────────────────────────────────────────────
// 같은 오버레이의 세 번째 채널. 도구/스킬이 "내 에이전트가 무엇을 쓰는가"라면 이건 "무엇으로 생각하는가"다.
// model=null 은 워크스페이스 기준선(AgentSpec.model → 서버 기본값)을 따르겠다는 뜻이고, 그래서 읽기가 기준선을
// 함께 실어 준다 — 기본값은 대신하는 값 옆에서만 의미가 있다.
export const agentModelPreferenceSchema = z.object({
  model: z.string().nullable(),
  workspaceDefault: z.string().nullable(),
})
export type AgentModelPreference = z.infer<typeof agentModelPreferenceSchema>

// 드리프트 가드 — 계약 wire 타입이 바뀌면 웹 타입체크가 깨진다(양방향).
type AssertAssignable<A extends B, B> = A
type _Fwd = AssertAssignable<AgentToolEntry, ContractAgentToolEntry>
type _Back = AssertAssignable<ContractAgentToolEntry, AgentToolEntry>
type _FnFwd = AssertAssignable<AgentToolFunction, ContractAgentToolFunction>
type _DetailFwd = AssertAssignable<AgentToolDetail, ContractAgentToolDetail>
type _ProbeFwd = AssertAssignable<AgentToolProbe, ContractAgentToolProbe>
type _ModelFwd = AssertAssignable<AgentModelPreference, ContractAgentModelPreference>
type _ModelBack = AssertAssignable<ContractAgentModelPreference, AgentModelPreference>
