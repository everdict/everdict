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
  ProductSeriesRunResponse as WireProductSeriesRunResponse,
  ProductServiceSuggestion as WireProductServiceSuggestion,
  ProductSyncResponse as WireProductSyncResponse,
  ProductTimelineResponse as WireProductTimelineResponse,
  ReleaseDetailResponse as WireReleaseDetailResponse,
  RepoPackage as WireRepoPackage,
  RepoVersionSample as WireRepoVersionSample,
} from '@everdict/contracts/wire'
import { z } from 'zod'

import { trackerHistoryEntrySchema } from '@/entities/issue'

// The product timeline (docs/architecture/product-timeline.md) — the "what do we ship" axis. A product declares
// the services its real composition is made of (GitHub releases/tags arrive as a version ledger) and the watch
// series that judge its quality (dataset × harness × judges). A release is a gated checkpoint on that axis.
// Runtime boundary validation stays here (zod v4); the EXPORTED types come from @everdict/contracts.

const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const PRODUCT_SERVICE_SOURCES = ['releases', 'tags'] as const
export const productServiceSourceSchema = z.enum(PRODUCT_SERVICE_SOURCES)

export const productServiceSyncSchema = z.object({
  syncedAt: z.string().optional(),
  lastError: z.object({ at: z.string(), message: z.string() }).optional(),
})

// One tracked service — its NAME is the timeline's key (change the repo/source/prefix and the watermark resets into a new track).
export const productServiceSchema = z.object({
  name: z.string(),
  host: z.string().optional(),
  repository: z.string(),
  source: productServiceSourceSchema,
  tagPrefix: z.string().optional(),
  // Where this service lives inside the repo (a monorepo) — configuration, not stream identity.
  path: z.string().optional(),
  sync: productServiceSyncSchema.optional(),
})

const seriesCapabilityRefSchema = z.object({
  id: z.string(),
  // Absent = latest at run time — exactly what a standing series means (a CI re-pin mints a new instance version and that is what gets evaluated).
  version: z.string().optional(),
})

// One watch series — `key` is the trend's durable identity (rename the label and the history still follows).
export const productSeriesSchema = z.object({
  key: z.string(),
  label: z.string(),
  dataset: seriesCapabilityRefSchema,
  harness: seriesCapabilityRefSchema,
  judges: z.array(seriesCapabilityRefSchema).default([]),
  // Whether the release gate reads it — absent = true (fail-closed). Exemption is an explicit product policy, never an inference from missing evidence.
  requiredForRelease: z.boolean().optional(),
})

export const productAutoEvalSchema = z.object({
  enabled: z.boolean(),
  runtime: z.string().optional(),
})

export const productSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // The address the URL carries — derived from the name and immutable afterwards (mig 0169). Rows written before
  // the column existed may have none, and are addressed by id instead (`productRef`).
  slug: z.string().optional(),
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

// One line of the composition this release ships — a service and its version. No version = "not decided yet", which
// is the real state of a plan (filling it from the ledger's latest pins a version nobody chose into the plan).
export const releaseComponentSchema = z.object({
  service: z.string(),
  version: z.string().optional(),
  // The exact ledger row the picker chose — a service of the same name that moves repository forks the stream, and two
  // streams can both publish a v1.0.0. Send only the version string and nobody can answer which row shipped.
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
  // Which series judge this release. Absent = every series the product declares.
  seriesKeys: z.array(z.string()).optional(),
  // Which service versions go out together. Absent = no composition was ever declared (an empty array = no tracked service ships).
  components: z.array(releaseComponentSchema).optional(),
  history: z.array(trackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const PRODUCT_VERSION_KINDS = ['release', 'tag'] as const
export const productVersionKindSchema = z.enum(PRODUCT_VERSION_KINDS)

// One imported version-ledger row — `publishedAt` is the REMOTE's clock (GitHub's).
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

// Release readiness — the per-series verdict is the scorecard gate's own vocabulary (the product layer does not reinvent truth).
// `not_evaluated` is never green on a required series: no evaluation is a block, not a pass.
export const seriesVerdictSchema = z.enum([
  'pass',
  'no_baseline',
  'block',
  'blocked_missing',
  'not_comparable',
  'not_evaluated',
  // First ship: there is evidence and nothing to compare it against. "Cannot compare" and "safe to ship" are different
  // sentences, so the default is a block and the series policy `allowNoBaseline` is the explicit approval (arch-review 8 P1).
  'bootstrap_required',
  // The product no longer declares the series this release promised to be judged by (arch-review 12 P0).
  // Not a measurement — the GATE itself is gone, so it always blocks rather than passes.
  'scope_invalid',
  // There is evidence, and it came from a different evaluation contract than the one this series now declares (dataset/harness/judges, arch-review 13 P0).
  // The question changed, so it is an answer to a different question, and it blocks exactly as never having evaluated does.
  'contract_stale',
  // What this series even ASKS cannot be resolved — a deleted dataset, a registry outage (arch-review 14 P0).
  // "We could not find out" has never been a synonym for "it is fine", so a required series blocks.
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
      // WHICH verdict — a scorecard id stopped being an evidence reference the moment a re-score became possible.
      scoring: z.object({ revision: z.number(), scorePlaneDigest: z.string() }).optional(),
      serviceVersion: z.string().optional(),
    })
    .optional(),
  baseline: z
    .object({
      scorecardId: z.string(),
      passRate: z.number().optional(),
      createdAt: z.string(),
      // WHICH verdict — a scorecard id stopped being an evidence reference the moment a re-score became possible.
      scoring: z.object({ revision: z.number(), scorePlaneDigest: z.string() }).optional(),
    })
    .optional(),
  verdict: seriesVerdictSchema,
  // Was this series a gate AT DECISION TIME — product policy is editable, so a re-read after the decision cannot answer it.
  required: z.boolean().optional(),
  reasons: z.array(z.string()).optional(),
  // Does this series block the ship — required && verdict ∉ {pass, no_baseline}
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

// GET /products/:id/timeline — one read the server composes out of the stores. The web only draws it.
export const productSeriesPointSchema = z.object({
  scorecardId: z.string(),
  status: z.string(),
  passRate: z.number().optional(),
  createdAt: z.string(),
  serviceVersion: z.string().optional(),
  releaseId: z.string().optional(),
})

// Version-registration events for the capabilities a watch series declares (harness · dataset · judges) — what the
// evaluation contract did while the service moved. `seriesKeys` are the series watching this capability (on a product
// with several series, the answer to "whose contract moved").
export const productTimelineCapabilitySchema = z.object({
  kind: z.enum(['harness', 'dataset', 'judge']),
  id: z.string(),
  version: z.string(),
  registeredAt: z.string(),
  seriesKeys: z.array(z.string()),
})

export const productTimelineSchema = z.object({
  // `to` is not "now" but the furthest goal date the product promised — putting a PLANNED release on the axis needs
  // the window to cover the future. `now` is therefore part of the window: the boundary between what happened and
  // what is scheduled, and where an unfinished span (an open issue) stops.
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
      // How this issue reached the timeline — an explicit link (product/release), or citing this product's evaluation
      // evidence as its grounds (evidence). Two different claims, so they are drawn in different lanes.
      via: z.enum(['product', 'release', 'evidence']),
      createdAt: z.string(),
      resolvedAt: z.string().optional(),
      resolvedByScorecardId: z.string().optional(),
      releaseId: z.string().optional(),
    })
  ),
  // A boundary default — the whole timeline does not die when the control plane and the web are one deploy apart
  // on this field (an honest degradation where only the capability lane is empty).
  capabilities: z.array(productTimelineCapabilitySchema).default([]),
})

// GET /products/repo-options — the GitHub App's installed repos (= the set a sync can get a token for).
export const repoOptionsSchema = z.array(
  z.object({
    fullName: z.string(),
    host: z.string().optional(),
    private: z.boolean(),
  })
)

// POST /products/discover — the composition a repo states about itself. The wizard makes the user PICK service rows
// out of this response alone (typing a prefix by hand ends in a silent zero-row import). `versions` is the sample the
// client re-counts when the prefix changes, so a preview costs no extra GitHub round trip.
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
  // Only suggestions a real stream backs are selected by default — the rest are "directories that look like a deploy unit".
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
  // false = the read hit its ceiling → every count is a lower bound.
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

// The result of an on-demand series run — the batches submitted, and the series that could NOT be. Swallowing the
// latter reads as "we asked and got no answer at all".
export const productSeriesRunResultSchema = z.object({
  triggered: z.array(z.string()),
  failedSeries: z.array(z.object({ key: z.string(), error: z.string() })),
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
type _seriesRunFwd = AssertAssignable<
  z.infer<typeof productSeriesRunResultSchema>,
  WireProductSeriesRunResponse
>
type _seriesRunBack = AssertAssignable<
  WireProductSeriesRunResponse,
  z.infer<typeof productSeriesRunResultSchema>
>
type _syncFwd = AssertAssignable<z.infer<typeof productSyncResultSchema>, WireProductSyncResponse>
type _syncBack = AssertAssignable<WireProductSyncResponse, z.infer<typeof productSyncResultSchema>>
type _timelineFwd = AssertAssignable<
  z.infer<typeof productTimelineSchema>,
  WireProductTimelineResponse
>

export type Product = WireProductRecord
export type ProductTimelineCapability = WireProductTimelineResponse['capabilities'][number]
export type ProductService = WireProductService
export type ProductSeries = WireProductSeries
export type ProductDetail = WireProductDetailResponse
export type ProductTimeline = WireProductTimelineResponse
export type ProductVersion = WireProductServiceVersionRecord
export type ProductSyncResult = WireProductSyncResponse
export type ProductSeriesRunResult = WireProductSeriesRunResponse
export type ProductRepoDiscovery = WireProductRepoDiscoveryResponse
export type ProductServiceSuggestion = WireProductServiceSuggestion
export type RepoPackage = WireRepoPackage
export type RepoVersionSample = WireRepoVersionSample
export type Release = WireReleaseRecord
export type ReleaseComponent = WireReleaseComponent
export type ReleaseDetail = WireReleaseDetailResponse
export type ReleaseReadiness = WireReleaseReadiness
export type ReleaseStatus = WireReleaseStatus
