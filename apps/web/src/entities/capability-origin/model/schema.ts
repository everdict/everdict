import type { CapabilityOrigin as WireCapabilityOrigin } from '@everdict/contracts'
import { z } from 'zod'

// 등록된 버전이 "어디서 왔는가" — 이슈에서 태어났는지, 어떤 에이전트가 어느 대화에서 만들었는지.
// 런타임 검증은 여기(zod v4), EXPORT 하는 타입은 @everdict/contracts 앵커(재아키텍처 P4).
//
// 목록 응답에 `versionOrigins`(버전 → 출처)로 실려 온다. 상세 화면이 최신 버전의 출처를 뽑아 쓰고,
// 버전 목록은 각자 자기 출처를 그린다 — v1 이 이슈에서 태어나고 v2 가 다른 대화에서 다듬어졌다면
// 그건 서로 다른 답이며, 첫 버전으로 뭉뚱그리면 가장 최신 버전이 가장 설명되지 않는다.
export const capabilityOriginSourceTypeSchema = z.enum([
  'issue',
  'project',
  'initiative',
  'scorecard',
  'run',
  'trace',
  'harness',
  'agent',
  'dataset',
  'judge',
  'benchmark',
])

export const capabilityOriginRefSchema = z.object({
  type: capabilityOriginSourceTypeSchema,
  id: z.string(),
  version: z.string().optional(),
  // 등록 시점에 찍힌 표시용 스냅샷(`ENG-12 제목`). id 가 해석의 기준이고 이건 그리기 위한 값이다.
  label: z.string().optional(),
})

export const capabilityOriginSchema = z.object({
  via: z.enum(['web', 'mcp', 'ci', 'import']),
  from: capabilityOriginRefSchema.optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  note: z.string().optional(),
})

// 버전 → 출처. 찍힌 버전만 들어 있다(아무 버전도 안 찍혔으면 필드 자체가 없다).
export const versionOriginsSchema = z.record(z.string(), capabilityOriginSchema)

type AssertAssignable<A extends B, B> = A
type WebCapabilityOrigin = z.infer<typeof capabilityOriginSchema>
type _originFwd = AssertAssignable<WebCapabilityOrigin, WireCapabilityOrigin>
type _originBack = AssertAssignable<WireCapabilityOrigin, WebCapabilityOrigin>
export type { _originFwd, _originBack }

export type CapabilityOrigin = WireCapabilityOrigin
export type CapabilityOriginRef = NonNullable<WireCapabilityOrigin['from']>
export type VersionOrigins = Record<string, CapabilityOrigin>

// 그릴 게 있는가 — 채널(via)만 있는 출처는 "웹에서 등록됨"이라는 뻔한 말뿐이라 섹션을 만들 이유가 없다.
// 상세 화면의 "빈 섹션은 숨긴다" 관습이 여기서도 그대로 적용된다.
export function hasLineage(origin: CapabilityOrigin | undefined): boolean {
  if (!origin) return false
  return (
    origin.from !== undefined ||
    origin.agentId !== undefined ||
    origin.agentName !== undefined ||
    origin.conversationId !== undefined ||
    origin.note !== undefined
  )
}

// 상세 화면이 그릴 출처 하나를 고른다. 화면이 보여주는 버전의 스탬프가 우선이고, 그 버전에 스탬프가 없으면
// 가장 오래된 스탬프로 물러난다 — "이건 어디서 왔나"의 답은 결국 태어난 자리이고, 최신 버전이 그냥 판올림된
// 것이라면 출생 기록이 여전히 유효한 답이다. 아무 버전도 안 찍혔으면(스탬프 이전에 만들어진 자산) undefined.
export function pickOrigin(
  origins: VersionOrigins | undefined,
  version: string,
  versionsAscending: readonly string[]
): CapabilityOrigin | undefined {
  if (!origins) return undefined
  const exact = origins[version]
  if (exact) return exact
  for (const v of versionsAscending) {
    const found = origins[v]
    if (found) return found
  }
  return undefined
}

// 출처가 가리키는 대상의 상세 경로. 이슈는 identifier 로도 열리므로 id 를 그대로 쓴다.
// 링크를 만들 수 없는 종류(trace 등)는 undefined — 칩은 텍스트로 남는다.
// Each entry addresses ONE thing, so each is the singular segment — the plural is that resource's list page.
const ORIGIN_ROUTES: Partial<Record<CapabilityOriginRef['type'], string>> = {
  issue: 'issue',
  project: 'project',
  initiative: 'initiative',
  scorecard: 'scorecard',
  run: 'run',
  harness: 'harness',
  dataset: 'dataset',
  judge: 'judge',
}

export function originRefHref(workspace: string, ref: CapabilityOriginRef): string | undefined {
  const segment = ORIGIN_ROUTES[ref.type]
  return segment ? `/${workspace}/${segment}/${encodeURIComponent(ref.id)}` : undefined
}
