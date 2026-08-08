import type {
  ProductAutoEval as WireProductAutoEval,
  ProductRecord as WireProductRecord,
  ProductSeries as WireProductSeries,
  ProductService as WireProductService,
  ProductServiceVersionRecord as WireProductServiceVersionRecord,
  ReleaseReadiness as WireReleaseReadiness,
  ReleaseRecord as WireReleaseRecord,
  ReleaseStatus as WireReleaseStatus,
} from '@everdict/contracts'
import type {
  ProductDetailResponse as WireProductDetailResponse,
  ProductSyncResponse as WireProductSyncResponse,
  ProductTimelineResponse as WireProductTimelineResponse,
  ReleaseDetailResponse as WireReleaseDetailResponse,
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
])
export const releaseSeriesStateSchema = z.object({
  key: z.string(),
  label: z.string(),
  latest: z
    .object({
      scorecardId: z.string(),
      passRate: z.number().optional(),
      createdAt: z.string(),
      serviceVersion: z.string().optional(),
    })
    .optional(),
  baseline: z
    .object({
      scorecardId: z.string(),
      passRate: z.number().optional(),
      createdAt: z.string(),
    })
    .optional(),
  verdict: seriesVerdictSchema,
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
  window: z.object({ from: z.string(), to: z.string() }),
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
export type Release = WireReleaseRecord
export type ReleaseDetail = WireReleaseDetailResponse
export type ReleaseReadiness = WireReleaseReadiness
export type ReleaseStatus = WireReleaseStatus
