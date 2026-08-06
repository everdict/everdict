import type {
  CapabilityRecord as ContractCapabilityRecord,
  CapabilitySpecDiff as ContractCapabilitySpecDiff,
  EnvironmentPreset,
  ModelBinding,
} from '@everdict/contracts'
import { z } from 'zod'

// Capability Store — 멤버가 저작·발행하고 다른 멤버가 채택(도구 kind)하거나 하네스 저작에서 소비(environment)하는 하나의
// 판별자 엔티티(mcp|code|skill|environment). 경계 검증은 여기 zod v4 에서만, EXPORT 타입은 @everdict/contracts 고정(P4).
// `import type` 만 — 계약의 zod v3 스키마는 웹에서 실행되지 않는다.

// 공개범위(reach) 4단계. subset=작성자 자기 워크스페이스들 중 일부(sharedWith), public=전체 노출(admin 게이트).
export const capabilityVisibilitySchema = z.enum(['private', 'workspace', 'subset', 'public'])
export type CapabilityVisibility = z.infer<typeof capabilityVisibilitySchema>

export const capabilityTypeSchema = z.enum(['mcp', 'code', 'skill', 'environment', 'delegation'])
export type CapabilityType = z.infer<typeof capabilityTypeSchema>

// 채택자가 자기 시크릿으로 채워야 하는 값 — 이름 + 설명만(값 아님).
const requiredSecretSchema = z.object({ name: z.string(), description: z.string() })

// 판별자 spec — 한 capability 는 정확히 세 종류 중 하나.
// mcp — 두 transport: 원격 HTTP(`url`) 또는 컨테이너 stdio(`image`, `docker run -i`). 정확히 하나(계약 저장 경계에서 강제).
const mcpToolSpecSchema = z.object({
  type: z.literal('mcp'),
  url: z.string().optional(),
  image: z.string().optional(),
  args: z.array(z.string()),
  provides: z.array(z.string()),
  requiredSecrets: z.array(requiredSecretSchema),
  write: z.boolean(),
})
// code 도구의 워크드 예제 — 스토어 상세 표시·try 실행·에이전트 tool description 3중 용도(입력 형태를 실호출로 보여준다).
export const codeToolExampleSchema = z.object({
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  note: z.string().optional(),
})
export type CodeToolExample = z.infer<typeof codeToolExampleSchema>

const codeToolSpecSchema = z.object({
  type: z.literal('code'),
  language: z.enum(['python', 'node']),
  code: z.string(),
  parametersSchema: z.record(z.string(), z.unknown()),
  isReadOnly: z.boolean(),
  requiredSecrets: z.array(requiredSecretSchema),
  timeoutSec: z.number().optional(),
  image: z.string().optional(),
  examples: z.array(codeToolExampleSchema),
})
const skillCapabilitySpecSchema = z.object({
  type: z.literal('skill'),
  instructions: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
})

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

// delegation — 에버딕트가 일을 맡기는 작업 환경. 어떤 대화형 에이전트가 · 어떤 이미지에서 · 어떤 모델/env로 ·
// 어떤 상시 지시(instructions) 아래 도는지를 한 번 정의해두고 참조로만 위임한다(capability-store.md §Fifth kind).
// env 값은 리터럴 또는 {secretRef} — 컨트롤플레인 EnvValueSchema 미러(웹은 표시만 하고 재구성하지 않는다).
const delegationEnvValueSchema = z.union([
  z.string(),
  z.object({ secretRef: z.string(), scope: z.enum(['user', 'workspace']).optional() }),
])
const delegationProfileSpecSchema = z.object({
  type: z.literal('delegation'),
  harness: z.object({ id: z.string(), version: z.string().optional() }),
  image: z.string(),
  model: z
    .custom<ModelBinding>((v) => typeof v === 'string' || (typeof v === 'object' && v !== null))
    .optional(),
  env: z.record(z.string(), delegationEnvValueSchema),
  workDir: z.string().optional(),
  instructions: z.string(),
  instructionsFile: z.string(),
  ttlSec: z.number().optional(),
})

export const capabilitySpecSchema = z.discriminatedUnion('type', [
  mcpToolSpecSchema,
  codeToolSpecSchema,
  skillCapabilitySpecSchema,
  environmentImageSpecSchema,
  delegationProfileSpecSchema,
])
export type CapabilitySpec = z.infer<typeof capabilitySpecSchema>

// GET /capabilities · /capabilities/public · /capabilities/:id — 전체 CapabilityRecord
// + (environment kind 만) 뷰어 워크스페이스 레지스트리 기준 imageClass 주석(컨트롤플레인 계산·비영속, P1g 선례).
export const capabilityImageClassSchema = z.enum([
  'managed',
  'workspace',
  'external',
  'local',
  'unqualified',
])
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

// POST /capabilities/validate 200 — save dry-run: 스펙 파싱 실패(ok:false) 또는 버전 예측 + 이미지 경고(ok:true).
export const validateCapabilityResultSchema = z.union([
  z.object({ ok: z.literal(false), errors: z.array(z.string()) }),
  z.object({
    ok: z.literal(true),
    id: z.string(),
    type: capabilityTypeSchema,
    willCreate: z.boolean(),
    version: z.string(),
    existingVersions: z.array(z.string()),
    imageWarnings: z.array(z.object({ image: z.string(), class: z.string() })).optional(),
  }),
])
export type ValidateCapabilityResult = z.infer<typeof validateCapabilityResultSchema>

// POST /capabilities/probe-mcp 200 — mcp 연결 테스트: 도달성 + 발견한 도구(provides 자동채움용). 실패는 결과(reachable:false).
export const probeCapabilityMcpResultSchema = z.object({
  reachable: z.boolean(),
  detail: z.string(),
  reason: z.enum(['auth', 'unreachable', 'protocol']).optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
})
export type ProbeCapabilityMcpResult = z.infer<typeof probeCapabilityMcpResultSchema>

// GET /workspace/image-registries/tags — environment 이미지 피커용 태그 목록.
export const imageTagsSchema = z.object({
  registry: z.string(),
  repository: z.string(),
  tags: z.array(z.string()),
})
export type ImageTags = z.infer<typeof imageTagsSchema>

// GET /workspace/image-registries/verify — 저작 시점 실 pull 검증. 정적 분류 경고(imageWarnings)와 달리 레지스트리에
// 실제로 물어본 결과이고, digest 가 오면 그것이 재현 가능한 핀이다. 실패도 200 결과(pullable:false + reason).
export const imageVerifySchema = z.object({
  pullable: z.boolean(),
  reason: z.enum(['ok', 'auth', 'not-found', 'unreachable']),
  digest: z.string().optional(),
})
export type ImageVerify = z.infer<typeof imageVerifySchema>

// POST /agent/code-tools/try 200 — code 도구 검증 결과. check=구문(파스만) · run=예제 입력 실제 실행(에이전트와 동일
// 실행계약+샌드박스 게이트). 무상태·영속 안 됨(스킬 try 와 동형이라 계약 앵커 없이 로컬 형태만).
export const codeToolTryResultSchema = z.object({
  mode: z.enum(['check', 'run']),
  ok: z.boolean(),
  content: z.string(),
  durationMs: z.number(),
  missingSecrets: z.array(z.string()),
})
export type CodeToolTryResult = z.infer<typeof codeToolTryResultSchema>

// GET /capabilities/:id/versions — 이 워크스페이스가 볼 수 있는 라이브 버전(오름차순) + 버전→태그 표시맵.
// source=오너 워크스페이스(내 것, 또는 크로스테넌트 public/subset 오너). API 전용 응답이라 계약 앵커 없음.
export const capabilityVersionsSchema = z.object({
  id: z.string(),
  source: z.string(),
  versions: z.array(z.string()),
  versionTags: z.record(z.string(), z.array(z.string())),
})
export type CapabilityVersions = z.infer<typeof capabilityVersionsSchema>

// GET /capabilities/:id/diff — 두 버전의 불변 콘텐츠(name/description/spec) 구조 diff. 타입은 계약 고정(드리프트 가드).
const capabilityFieldChangeSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
})
export type CapabilityFieldChange = z.infer<typeof capabilityFieldChangeSchema>
export const capabilitySpecDiffSchema = z.object({
  id: z.string(),
  base: z.string(),
  candidate: z.string(),
  typeChanged: z.boolean(),
  changes: z.array(capabilityFieldChangeSchema),
  summary: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    changed: z.number().int(),
  }),
})
export type CapabilitySpecDiff = z.infer<typeof capabilitySpecDiffSchema>

// 드리프트 가드 — 레코드는 양방향(어느 쪽 필드 변경도 웹 타입체크를 깨뜨린다).
type AssertAssignable<A extends B, B> = A
type _CapFwd = AssertAssignable<Capability, ContractCapabilityRecord>
type _CapBack = AssertAssignable<ContractCapabilityRecord, Capability>
type _DiffFwd = AssertAssignable<CapabilitySpecDiff, ContractCapabilitySpecDiff>
type _DiffBack = AssertAssignable<ContractCapabilitySpecDiff, CapabilitySpecDiff>
