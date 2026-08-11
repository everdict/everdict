import type {
  ProductAutoEval as WireProductAutoEval,
  ProductRecord as WireProductRecord,
  ProductSeries as WireProductSeries,
  ProductService as WireProductService,
  ProductServiceVersionRecord as WireProductServiceVersionRecord,
  ReleaseComponent as WireReleaseComponent,
  ReleaseReadiness as WireReleaseReadiness,
  ReleaseRecord as WireReleaseRecord,
  ReleaseStatus as WireReleaseStatus,
} from '@everdict/contracts'
import type {
  ProductDetailResponse as WireProductDetailResponse,
  ProductRepoDiscoveryResponse as WireProductRepoDiscoveryResponse,
  ProductServiceSuggestion as WireProductServiceSuggestion,
  ProductSyncResponse as WireProductSyncResponse,
  ProductTimelineResponse as WireProductTimelineResponse,
  ReleaseDetailResponse as WireReleaseDetailResponse,
  RepoPackage as WireRepoPackage,
  RepoVersionSample as WireRepoVersionSample,
} from '@everdict/contracts/wire'
import { z } from 'zod'

import { trackerHistoryEntrySchema } from '@/entities/issue'

// 프로덕트 타임라인(docs/architecture/product-timeline.md) — "무엇을 배포하는가"의 축. 프로덕트는 실제 제품을
// 구성하는 서비스들(GitHub 릴리즈/태그가 버전 원장으로 들어온다)과, 제품의 품질을 판정하는 워치 시리즈
// (데이터셋×하네스×저지)를 선언한다. 릴리즈는 그 축 위의 게이트 달린 체크포인트다.
// Runtime boundary validation stays here (zod v4); the EXPORTED types come from @everdict/contracts.

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const PRODUCT_SERVICE_SOURCES = ['releases', 'tags'] as const
export const productServiceSourceSchema = z.enum(PRODUCT_SERVICE_SOURCES)

export const productServiceSyncSchema = z.object({
  syncedAt: z.string().optional(),
  lastError: z.object({ at: z.string(), message: z.string() }).optional(),
})

// 추적 서비스 하나 — 이름이 타임라인의 키다(레포/소스/프리픽스가 바뀌면 워터마크가 리셋되고 새 트랙이 된다).
export const productServiceSchema = z.object({
  name: z.string(),
  host: z.string().optional(),
  repository: z.string(),
  source: productServiceSourceSchema,
  tagPrefix: z.string().optional(),
  // 레포 안에서 이 서비스가 사는 경로(모노레포) — 스트림 정체성이 아니라 구성 정보다.
  path: z.string().optional(),
  sync: productServiceSyncSchema.optional(),
})

const seriesCapabilityRefSchema = z.object({
  id: z.string(),
  // 없음 = 실행 시점의 latest — 상시 시리즈의 의미 그대로(CI 재핀이 새 인스턴스 버전을 찍으면 그걸 평가한다).
  version: z.string().optional(),
})

// 워치 시리즈 하나 — key 가 추이의 영속 정체성이다(라벨을 바꿔도 이력은 그대로 이어진다).
export const productSeriesSchema = z.object({
  key: z.string(),
  label: z.string(),
  dataset: seriesCapabilityRefSchema,
  harness: seriesCapabilityRefSchema,
  judges: z.array(seriesCapabilityRefSchema).default([]),
  // 릴리즈 게이트 대상 여부 — 부재 = true(fail-closed). 게이트 제외는 명시적 제품 정책이지 근거 부재의 추론이 아니다.
  requiredForRelease: z.boolean().optional(),
})

export const productAutoEvalSchema = z.object({
  enabled: z.boolean(),
  runtime: z.string().optional(),
})

export const productSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  services: z.array(productServiceSchema).default([]),
  series: z.array(productSeriesSchema).default([]),
  autoEval: productAutoEvalSchema.default({ enabled: true }),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const productsSchema = z.array(productSchema)

export const RELEASE_STATUSES = ['planned', 'released', 'cancelled'] as const
export const releaseStatusSchema = z.enum(RELEASE_STATUSES)

// 이 릴리즈가 내보내는 구성 한 줄 — 서비스 하나와 그 버전. version 없음 = "아직 안 정해짐"(계획 단계의
// 진짜 상태다. 원장 최신값으로 채워 버리면 아무도 고르지 않은 버전이 계획에 박힌다).
export const releaseComponentSchema = z.object({
  service: z.string(),
  version: z.string().optional(),
  // 피커가 고른 원장 행 그 자체 — 같은 이름의 서비스가 저장소를 옮기면 스트림이 갈라지고, 두 스트림이
  // 같은 v1.0.0 을 발행할 수 있다. 버전 문자열만 보내면 출시 시점에 어느 행이었는지 아무도 답할 수 없다.
  versionRecordId: z.string().optional(),
})

export const releaseSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  productId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: releaseStatusSchema,
  targetDate: calendarDateSchema.optional(),
  releasedAt: z.string().optional(),
  // 이 릴리즈가 판정받는 시리즈 선택. 없음 = 프로덕트의 모든 시리즈.
  seriesKeys: z.array(z.string()).optional(),
  // 어떤 서비스 버전들이 함께 나가는가. 없음 = 구성을 선언한 적 없음(빈 배열 = 추적 서비스가 하나도 안 나감).
  components: z.array(releaseComponentSchema).optional(),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const PRODUCT_VERSION_KINDS = ['release', 'tag'] as const
export const productVersionKindSchema = z.enum(PRODUCT_VERSION_KINDS)

// 임포트된 버전 원장 한 행 — publishedAt 은 원격(GitHub)의 시계다.
export const productVersionSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  productId: z.string(),
  service: z.string(),
  version: z.string(),
  kind: productVersionKindSchema,
  prerelease: z.boolean().default(false),
  sha: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
  publishedAt: z.string(),
  importedAt: z.string(),
})

export const productDetailSchema = productSchema.extend({
  releases: z.array(releaseSchema),
  versions: z.array(productVersionSchema),
})

// 릴리즈 준비도 — 시리즈별 판정은 스코어카드 게이트의 어휘 그대로(제품 레이어는 진실을 재발명하지 않는다).
// not_evaluated 는 필수 시리즈에서 절대 green 이 아니다: 평가 없음은 통과가 아니라 차단이다.
export const seriesVerdictSchema = z.enum([
  'pass',
  'no_baseline',
  'block',
  'blocked_missing',
  'not_comparable',
  'not_evaluated',
  // 첫 출하: 증거는 있지만 비교할 기준이 없다. "비교 불가"와 "출하해도 된다"는 다른 문장이라
  // 기본은 차단이고, 시리즈 정책 allowNoBaseline 이 명시 승인이다(arch-review 8 P1).
  'bootstrap_required',
  // 이 릴리즈가 판정 기준으로 약속한 시리즈를 제품이 더는 선언하지 않는다(arch-review 12 P0).
  // 측정 결과가 아니라 게이트 자체가 사라진 상태라, 통과가 아니라 항상 차단이다.
  'scope_invalid',
  // 증거는 있지만 지금 시리즈가 선언한 평가 계약(데이터셋/하네스/저지)과 다른 계약에서 나왔다(arch-review 13 P0).
  // 질문이 바뀌었으므로 다른 질문에 대한 답이고, 한 번도 평가하지 않은 것과 똑같이 차단한다.
  'contract_stale',
  // 지금 시리즈가 무엇을 묻는지 자체를 해석할 수 없다 — 데이터셋 삭제, 레지스트리 장애(arch-review 14 P0).
  // "확인할 수 없었다"는 "괜찮다"의 동의어였던 적이 없으므로 필수 시리즈에서는 차단한다.
  'contract_unverifiable',
])
export const releaseSeriesStateSchema = z.object({
  key: z.string(),
  label: z.string(),
  latest: z
    .object({
      scorecardId: z.string(),
      passRate: z.number().optional(),
      createdAt: z.string(),
      // 어느 판정인가 — 스코어카드 id 는 re-score 가 가능해진 순간부터 증거 참조가 아니다.
      scoring: z.object({ revision: z.number(), scorePlaneDigest: z.string() }).optional(),
      serviceVersion: z.string().optional(),
    })
    .optional(),
  baseline: z
    .object({
      scorecardId: z.string(),
      passRate: z.number().optional(),
      createdAt: z.string(),
      // 어느 판정인가 — 스코어카드 id 는 re-score 가 가능해진 순간부터 증거 참조가 아니다.
      scoring: z.object({ revision: z.number(), scorePlaneDigest: z.string() }).optional(),
    })
    .optional(),
  verdict: seriesVerdictSchema,
  // 이 시리즈가 결정 시점에 게이트였는가 — 제품 정책은 편집 가능하므로 결정 이후 재조회로는 답할 수 없다.
  required: z.boolean().optional(),
  reasons: z.array(z.string()).optional(),
  // 이 시리즈가 출하를 차단하는가 — required && verdict ∉ {pass, no_baseline}
  regressed: z.boolean(),
})

export const releaseReadinessSchema = z.object({
  openIssues: z.number(),
  series: z.array(releaseSeriesStateSchema),
  regressedSeries: z.array(z.string()),
  ready: z.boolean(),
})

export const releaseDetailSchema = releaseSchema.extend({
  readiness: releaseReadinessSchema,
})

// GET /products/:id/timeline — 서버가 스토어를 합성해 주는 한 번의 read. 웹은 그리기만 한다.
export const productSeriesPointSchema = z.object({
  scorecardId: z.string(),
  status: z.string(),
  passRate: z.number().optional(),
  createdAt: z.string(),
  serviceVersion: z.string().optional(),
  releaseId: z.string().optional(),
})

export const productTimelineSchema = z.object({
  // `to` 는 "지금"이 아니라 프로덕트가 약속한 가장 먼 목표일까지다 — 계획된 릴리즈를 축 위에 놓으려면
  // 창이 미래를 덮어야 한다. `now` 는 그래서 창의 일부다: 일어난 구간과 예정 구간의 경계이고,
  // 끝나지 않은 스팬(미해결 이슈)이 멈추는 지점이다.
  window: z.object({ from: z.string(), to: z.string(), now: z.string() }),
  releases: z.array(releaseSchema),
  versions: z.array(productVersionSchema),
  series: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      points: z.array(productSeriesPointSchema),
    })
  ),
  issues: z.array(
    z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      status: z.string(),
      createdAt: z.string(),
      resolvedAt: z.string().optional(),
      releaseId: z.string().optional(),
    })
  ),
})

// GET /products/repo-options — GitHub App 설치 레포(= 싱크가 토큰을 받을 수 있는 집합).
export const repoOptionsSchema = z.array(
  z.object({
    fullName: z.string(),
    host: z.string().optional(),
    private: z.boolean(),
  })
)

// POST /products/discover — 레포가 스스로 말하는 구성. 위자드는 이 응답만으로 서비스 행을 "고르게" 한다
// (프리픽스를 손으로 치면 오타가 조용히 0건 임포트로 끝난다). versions 는 클라이언트가 프리픽스를 바꿀 때
// 다시 세는 표본이라, 프리뷰가 GitHub 왕복을 더 만들지 않는다.
export const repoVersionSampleSchema = z.object({
  name: z.string(),
  kind: productVersionKindSchema,
  prerelease: z.boolean(),
  publishedAt: z.string().optional(),
  url: z.string().optional(),
})

export const repoPackageSchema = z.object({
  path: z.string(),
  name: z.string(),
  manifest: z.string(),
})

export const productServiceSuggestionSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  source: productServiceSourceSchema,
  tagPrefix: z.string().optional(),
  // 실제 스트림이 뒷받침하는 제안만 기본 선택 — 나머지는 "배포 단위처럼 보이는 디렉터리"다.
  recommended: z.boolean(),
  matched: z.number(),
  latestVersion: z.string().optional(),
  latestPublishedAt: z.string().optional(),
  firstPublishedAt: z.string().optional(),
})

export const productRepoDiscoverySchema = z.object({
  repository: z.string(),
  host: z.string().optional(),
  source: productServiceSourceSchema,
  versions: z.array(repoVersionSampleSchema),
  packages: z.array(repoPackageSchema),
  suggestions: z.array(productServiceSuggestionSchema),
  // false = 읽기가 천장에 닿았다 → 모든 카운트는 하한이다.
  complete: z.boolean(),
})

export const productSyncResultSchema = z.object({
  services: z.array(
    z.object({
      name: z.string(),
      imported: z.number(),
      error: z.string().optional(),
    })
  ),
  triggered: z.array(z.string()),
  failedSeries: z.array(z.object({ key: z.string(), error: z.string() })).optional(),
})

// Drift guard — mutually assignable with the wire contract in both directions.
type AssertAssignable<A extends B, B> = A
type WebProduct = z.infer<typeof productSchema>
type _productFwd = AssertAssignable<WebProduct, WireProductRecord>
type _productBack = AssertAssignable<WireProductRecord, WebProduct>
type _serviceFwd = AssertAssignable<z.infer<typeof productServiceSchema>, WireProductService>
type _serviceBack = AssertAssignable<WireProductService, z.infer<typeof productServiceSchema>>
type _seriesFwd = AssertAssignable<z.infer<typeof productSeriesSchema>, WireProductSeries>
type _seriesBack = AssertAssignable<WireProductSeries, z.infer<typeof productSeriesSchema>>
type _autoEvalFwd = AssertAssignable<z.infer<typeof productAutoEvalSchema>, WireProductAutoEval>
type _autoEvalBack = AssertAssignable<WireProductAutoEval, z.infer<typeof productAutoEvalSchema>>
type _releaseFwd = AssertAssignable<z.infer<typeof releaseSchema>, WireReleaseRecord>
type _releaseBack = AssertAssignable<WireReleaseRecord, z.infer<typeof releaseSchema>>
type _releaseStatusFwd = AssertAssignable<z.infer<typeof releaseStatusSchema>, WireReleaseStatus>
type _releaseStatusBack = AssertAssignable<WireReleaseStatus, z.infer<typeof releaseStatusSchema>>
type _versionFwd = AssertAssignable<
  z.infer<typeof productVersionSchema>,
  WireProductServiceVersionRecord
>
type _versionBack = AssertAssignable<
  WireProductServiceVersionRecord,
  z.infer<typeof productVersionSchema>
>
type _readinessFwd = AssertAssignable<z.infer<typeof releaseReadinessSchema>, WireReleaseReadiness>
type _readinessBack = AssertAssignable<WireReleaseReadiness, z.infer<typeof releaseReadinessSchema>>
type _detailFwd = AssertAssignable<z.infer<typeof productDetailSchema>, WireProductDetailResponse>
type _detailBack = AssertAssignable<WireProductDetailResponse, z.infer<typeof productDetailSchema>>
type _releaseDetailFwd = AssertAssignable<
  z.infer<typeof releaseDetailSchema>,
  WireReleaseDetailResponse
>
type _releaseDetailBack = AssertAssignable<
  WireReleaseDetailResponse,
  z.infer<typeof releaseDetailSchema>
>
type _componentFwd = AssertAssignable<z.infer<typeof releaseComponentSchema>, WireReleaseComponent>
type _componentBack = AssertAssignable<WireReleaseComponent, z.infer<typeof releaseComponentSchema>>
type _discoveryFwd = AssertAssignable<
  z.infer<typeof productRepoDiscoverySchema>,
  WireProductRepoDiscoveryResponse
>
type _discoveryBack = AssertAssignable<
  WireProductRepoDiscoveryResponse,
  z.infer<typeof productRepoDiscoverySchema>
>
type _syncFwd = AssertAssignable<z.infer<typeof productSyncResultSchema>, WireProductSyncResponse>
type _syncBack = AssertAssignable<WireProductSyncResponse, z.infer<typeof productSyncResultSchema>>
type _timelineFwd = AssertAssignable<
  z.infer<typeof productTimelineSchema>,
  WireProductTimelineResponse
>

export type Product = WireProductRecord
export type ProductService = WireProductService
export type ProductSeries = WireProductSeries
export type ProductDetail = WireProductDetailResponse
export type ProductTimeline = WireProductTimelineResponse
export type ProductVersion = WireProductServiceVersionRecord
export type ProductSyncResult = WireProductSyncResponse
export type ProductRepoDiscovery = WireProductRepoDiscoveryResponse
export type ProductServiceSuggestion = WireProductServiceSuggestion
export type RepoPackage = WireRepoPackage
export type RepoVersionSample = WireRepoVersionSample
export type Release = WireReleaseRecord
export type ReleaseComponent = WireReleaseComponent
export type ReleaseDetail = WireReleaseDetailResponse
export type ReleaseReadiness = WireReleaseReadiness
export type ReleaseStatus = WireReleaseStatus
