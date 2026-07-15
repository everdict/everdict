import type {
  MetricSummary as WireMetricSummary,
  ScorecardExport as WireScorecardExport,
  ScorecardModels as WireScorecardModels,
  ScorecardStatus as WireScorecardStatus,
  ScorecardStep as WireScorecardStep,
  ScorecardTrialSummary as WireScorecardTrialSummary,
} from '@everdict/contracts'
import type {
  LeaderboardResponse,
  ScorecardDiffResponse,
  ScorecardResponse,
  ScorecardTrendResponse,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
//
// Posture: the clean aggregate/step/export/status sub-types are IDENTICAL to the record contracts (bidirectional).
// ScorecardOrigin is a NARROWER view (the web omits retryOf/memoryBoostMb) → Pick-reverse. The full ScorecardRecord
// is the run-style split: its FLAT fields anchor to the wire ScorecardResponse (which extends the record with the
// server-computed casePass), while `scorecard`/`orchestration`/`origin`/`caseResult`/`trace` stay DELIBERATELY
// LOOSE local views (the UI reads case scores/trace/snapshots by kind defensively, and never re-drives a batch).
// The suite DTOs (diff/trend/leaderboard) are identical to their wire response types (bidirectional).
export const scorecardStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'superseded',
  'cancelled',
])

// per-metric aggregation (shared by list/detail).
export const metricSummarySchema = z.object({
  metric: z.string(),
  count: z.number(),
  mean: z.number(),
  passRate: z.number().optional(),
})

// trial roll-up (pass@k / flakiness) — derived on the detail when a batch ran trials>1. Absent on single-run batches.
export const scorecardTrialSummarySchema = z.object({
  cases: z.number(), // cases with >=1 scored trial
  minTrials: z.number(),
  maxTrials: z.number(),
  passAt1: z.number(), // mean over cases of the per-case pass rate
  k: z.number(), // the k used for passAtK
  passAtK: z.number(),
  flakyCases: z.number(), // cases with mixed pass/fail across trials
  flakeRate: z.number(),
})

// per-case scores (loose — display fields only, the rest passthrough). detail = the grader/judge's verdict rationale (VLM rubric reasoning, etc.).
// Stays LOCAL: the contract Score's `detail` is `unknown` (discriminated), the web renders it as text.
export const caseScoreSchema = z
  .object({
    graderId: z.string(),
    metric: z.string(),
    value: z.number(),
    pass: z.boolean().optional(),
    detail: z.string().optional(),
  })
  .passthrough()

// trace events (loose) — display only looks at error events (case failure reasons). The rest passthrough. Stays LOCAL.
export const traceEventSchema = z
  .object({ kind: z.string(), message: z.string().optional() })
  .passthrough()

// per-case result (loose passthrough) — the discriminated trace/snapshot unions stay a local defensive view. Stays LOCAL.
export const caseResultSchema = z
  .object({
    caseId: z.string(),
    harness: z.string().optional(),
    verdict: z.boolean().optional(), // server-computed case verdict (authority rank) — served, never recomputed here
    scores: z.array(caseScoreSchema).default([]),
    trace: z.array(traceEventSchema).default([]), // case execution trace — error events expose the failure spans
    // classified failure (loose) — runnerId links a self-hosted no_runner/capability_mismatch case to the runner it
    // waited on ("*" = the owner pool); used to hint "check that runner is online" on the case. Stays LOCAL.
    failure: z
      .object({ class: z.string().optional(), runnerId: z.string().optional() })
      .passthrough()
      .optional(),

    // os-use=desktop snapshot (screenshot/screenshotRef → <img>). browser=service-topology snapshot (url=final URL, dom=excerpt).
    snapshot: z
      .object({
        kind: z.string(),
        screenshot: z.string().optional(),
        screenshotRef: z.string().optional(),
        url: z.string().optional(),
        dom: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

// the full scorecard for GET /scorecards/:id (including per-case results). Loose passthrough — stays LOCAL.
export const fullScorecardSchema = z
  .object({
    suiteId: z.string(),
    harness: z.string(),
    results: z.array(caseResultSchema).default([]),
  })
  .passthrough()

// execution process steps (timeline) — appended as the run progresses. The web shows the "progress" in this order.
export const scorecardStepSchema = z.object({
  ts: z.string(),
  phase: z.string(), // dispatch | judges | offload | persist | case
  status: z.enum(['started', 'ok', 'failed', 'info']),
  message: z.string(),
  caseId: z.string().optional(),
})

// the models this run actually used (leaderboard model axis). observed=trace-observed, declared=spec-declared, primary=representative (observed first).
export const scorecardModelsSchema = z.object({
  observed: z.array(z.string()).default([]),
  declared: z.string().optional(),
  primary: z.string().optional(),
})

// this run's trigger provenance — where it was fired from (github-actions|schedule|api|web) + commit coordinates.
// A GitHub Actions PR fire records a submit-time ephemeral pin (pinOverrides: slot→image) here (registry unchanged). Lightweight → also included in the list.
// NARROWER than the record ScorecardOrigin (the web omits retryOf/memoryBoostMb) — Pick-reverse guarded.
export const scorecardOriginSchema = z.object({
  source: z.string(),
  repo: z.string().optional(), // "owner/name"
  sha: z.string().optional(),
  ref: z.string().optional(), // refs/heads/… | refs/pull/…
  prNumber: z.number().optional(),
  runUrl: z.string().optional(), // CI run link
  pinOverrides: z.record(z.string(), z.string()).optional(), // submit-time ephemeral pin (slot→image)
})

// Trace-sink export result — a record of exporting per-case trace+scores to the workspace observability platform after grading.
// A failure is independent of the scorecard status (shown only via this status). Detail (get) only — not included in the list.
export const scorecardExportSchema = z.object({
  name: z.string().optional(), // registered name of the exported sink (multiple sinks — which sink it was)
  sink: z.enum(['mlflow', 'langfuse', 'langsmith', 'phoenix']),
  status: z.enum(['succeeded', 'partial', 'failed']),
  url: z.string().optional(), // deep link to the parent (experiment/project)
  message: z.string().optional(), // failure/partial reason
  exportedAt: z.string(),
  cases: z
    .array(
      z.object({
        caseId: z.string(),
        externalId: z.string().optional(), // platform trace/run id
        url: z.string().optional(), // deep link to the case trace
        error: z.string().optional(),
      })
    )
    .optional(),
})

export const scorecardRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }),
  status: scorecardStatusSchema,
  summary: z.array(metricSummarySchema).optional(),
  trialSummary: scorecardTrialSummarySchema.optional(), // pass@k / flakiness — present only on a multi-trial batch's detail
  models: scorecardModelsSchema.optional(), // unset on legacy records (unknown)
  judgeModels: z.array(z.string()).optional(), // the judge model(s) that graded this run — separate from the model axis (the grader)
  origin: scorecardOriginSchema.optional(), // trigger provenance — lightweight, so also included in the list. Unset on legacy records.
  createdBy: z.string().optional(), // the runner (submitter subject) — the 'who' paired with origin (the 'where'). Unset on legacy records.
  runtime: z.string().optional(), // the runtime the batch ran on (placement.target: registered runtime id | self:* runner). Unset = legacy·ingest records. Lightweight → also included in the list.
  // Batch-on-Temporal ownership — when set, a durable workflow drives this batch (shown as a chip on the detail).
  orchestration: z.object({ workflowId: z.string().optional() }).passthrough().optional(),
  // Partial-run (subset) marker — this batch ran only a subset of the dataset ({selected}/{total}). Unset = full run.
  subset: z
    .object({
      total: z.number().int(),
      selected: z.number().int(),
      ids: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().optional(),
    })
    .optional(),
  scorecard: fullScorecardSchema.optional(),
  // Server-computed rollup of per-case verdicts (detail only) — replaces the deleted client-side casePass mirror.
  casePass: z.object({ pass: z.number().int(), total: z.number().int() }).optional(),
  export: scorecardExportSchema.optional(), // trace-sink export result (detail only)
  error: z
    .object({ code: z.string(), message: z.string(), phase: z.string().optional() })
    .optional(),
  steps: z.array(scorecardStepSchema).default([]), // progress timeline (updated even while in progress)
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const scorecardsSchema = z.array(scorecardRecordSchema)

// GET /scorecards/diff response: baseline vs candidate (metric mean delta + case regressions/improvements).
export const caseDeltaSchema = z.object({
  caseId: z.string(),
  metric: z.string(),
  baseline: z.number(),
  candidate: z.number(),
  delta: z.number(),
  passChange: z.enum(['fixed', 'broke']).optional(),
})

// A trial-aware per-case delta — baseline vs candidate pass RATE over N trials + the two-proportion z gate.
export const trialCaseDeltaSchema = z.object({
  caseId: z.string(),
  baselineRate: z.number(),
  baselineTrials: z.number(),
  candidateRate: z.number(),
  candidateTrials: z.number(),
  delta: z.number(),
  z: z.number(), // two-proportion z of candidate vs baseline (negative = candidate lower)
  significant: z.boolean(), // |z| >= zThreshold
})

// Statistically-gated diff — attached to the diff response when either side ran trials (regressions are the
// significant pass-rate drops, not single flips). docs/architecture/trial-based-verdict.md
export const trialDiffSchema = z.object({
  baseline: z.string(),
  candidate: z.string(),
  zThreshold: z.number(),
  cases: z.array(trialCaseDeltaSchema),
  regressions: z.array(trialCaseDeltaSchema),
  improvements: z.array(trialCaseDeltaSchema),
})

export const scorecardDiffSchema = z.object({
  baseline: z.string(),
  candidate: z.string(),
  metrics: z.array(
    z.object({
      metric: z.string(),
      baselineMean: z.number(),
      candidateMean: z.number(),
      delta: z.number(),
    })
  ),
  regressions: z.array(caseDeltaSchema),
  improvements: z.array(caseDeltaSchema),
  trials: trialDiffSchema.optional(), // statistical (pass@k) gate — present only when either side ran trials
})

// GET /scorecards/trend response: time-ordered scorecards for one (dataset, metric) + regression vs baseline.
export const trendPointSchema = z.object({
  scorecardId: z.string(),
  harness: z.string(),
  createdAt: z.string(),
  mean: z.number().nullable(),
  passRate: z.number().nullable(),
  score: z.number().nullable(),
  deltaVsBaseline: z.number().nullable(),
  regressed: z.boolean(),
})

export const scorecardTrendSchema = z.object({
  dataset: z.string(),
  metric: z.string(),
  baseline: z.string(),
  points: z.array(trendPointSchema),
})

// GET /scorecards/leaderboard response: (harness × model) ranking for one dataset (benchmark) (metric descending).
export const leaderboardRowSchema = z.object({
  rank: z.number(),
  harness: z.object({ id: z.string(), version: z.string() }),
  model: z.string().optional(),
  judgeModels: z.array(z.string()).optional(), // the judge model(s) that graded the representative run
  scorecardId: z.string(),
  createdAt: z.string(),
  score: z.number().nullable(),
  passRate: z.number().nullable(),
  mean: z.number().nullable(),
  runs: z.number(),
})

export const leaderboardSchema = z.object({
  dataset: z.string(),
  metric: z.string(),
  window: z.enum(['latest', 'best']),
  rows: z.array(leaderboardRowSchema),
})

// Drift guards.
type AssertAssignable<A extends B, B> = A
type WebScorecardStatus = z.infer<typeof scorecardStatusSchema>
type WebMetricSummary = z.infer<typeof metricSummarySchema>
type WebScorecardTrialSummary = z.infer<typeof scorecardTrialSummarySchema>
type WebScorecardStep = z.infer<typeof scorecardStepSchema>
type WebScorecardModels = z.infer<typeof scorecardModelsSchema>
type WebScorecardExport = z.infer<typeof scorecardExportSchema>
type WebScorecardOrigin = z.infer<typeof scorecardOriginSchema>
type WebScorecardRecord = z.infer<typeof scorecardRecordSchema>
type WebScorecardDiff = z.infer<typeof scorecardDiffSchema>
type WebScorecardTrend = z.infer<typeof scorecardTrendSchema>
type WebLeaderboard = z.infer<typeof leaderboardSchema>

// Identical-shape sub-types — bidirectional against the record contracts.
type _statusFwd = AssertAssignable<WebScorecardStatus, WireScorecardStatus>
type _statusBack = AssertAssignable<WireScorecardStatus, WebScorecardStatus>
type _metricFwd = AssertAssignable<WebMetricSummary, WireMetricSummary>
type _metricBack = AssertAssignable<WireMetricSummary, WebMetricSummary>
type _trialFwd = AssertAssignable<WebScorecardTrialSummary, WireScorecardTrialSummary>
type _trialBack = AssertAssignable<WireScorecardTrialSummary, WebScorecardTrialSummary>
type _stepFwd = AssertAssignable<WebScorecardStep, WireScorecardStep>
type _stepBack = AssertAssignable<WireScorecardStep, WebScorecardStep>
type _modelsFwd = AssertAssignable<WebScorecardModels, WireScorecardModels>
type _modelsBack = AssertAssignable<WireScorecardModels, WebScorecardModels>
type _exportFwd = AssertAssignable<WebScorecardExport, WireScorecardExport>
type _exportBack = AssertAssignable<WireScorecardExport, WebScorecardExport>
// ScorecardOrigin is narrower (omits retryOf/memoryBoostMb) — Pick-reverse.
type _originFieldsOnWire = AssertAssignable<
  Pick<WireScorecardResponseOrigin, keyof WebScorecardOrigin>,
  WebScorecardOrigin
>
type WireScorecardResponseOrigin = NonNullable<ScorecardResponse['origin']>
// ScorecardRecord — run-style split: the FLAT fields (excluding the loose scorecard/orchestration/origin) must
// exist on the wire ScorecardResponse with an assignable type. (casePass is a server-computed field on the
// response, not the bare record; it anchors here.) `steps` is also excluded: the web applies `.default([])`
// (always-present) while the wire keeps it optional — a default-driven optionality difference, not a field
// drift, and its element shape is already guarded bidirectionally by _stepFwd/_stepBack above.
type WebScorecardFlat = Omit<WebScorecardRecord, 'scorecard' | 'orchestration' | 'origin' | 'steps'>
type _recordFieldsOnWire = AssertAssignable<
  Pick<ScorecardResponse, keyof WebScorecardFlat>,
  WebScorecardFlat
>
// Suite DTOs — identical to their wire response types (bidirectional).
type _diffFwd = AssertAssignable<WebScorecardDiff, ScorecardDiffResponse>
type _diffBack = AssertAssignable<ScorecardDiffResponse, WebScorecardDiff>
type _trendFwd = AssertAssignable<WebScorecardTrend, ScorecardTrendResponse>
type _trendBack = AssertAssignable<ScorecardTrendResponse, WebScorecardTrend>
type _lbFwd = AssertAssignable<WebLeaderboard, LeaderboardResponse>
type _lbBack = AssertAssignable<LeaderboardResponse, WebLeaderboard>

// Exported names alias the contract types where identical; the narrower/loose ones keep the web shape (anchored
// by the guards above). Consumers are untouched (same identifiers).
export type ScorecardStatus = WireScorecardStatus
export type MetricSummary = WireMetricSummary
export type ScorecardTrialSummary = WireScorecardTrialSummary
export type ScorecardStep = WireScorecardStep
export type ScorecardModels = WireScorecardModels
export type ScorecardExport = WireScorecardExport
export type ScorecardOrigin = WebScorecardOrigin
export type ScorecardRecord = WebScorecardRecord
export type CaseDelta = z.infer<typeof caseDeltaSchema>
export type TrialCaseDelta = z.infer<typeof trialCaseDeltaSchema>
export type TrialDiff = NonNullable<ScorecardDiffResponse['trials']>
export type ScorecardDiff = ScorecardDiffResponse
export type TrendPoint = ScorecardTrendResponse['points'][number]
export type ScorecardTrend = ScorecardTrendResponse
export type LeaderboardRow = LeaderboardResponse['rows'][number]
export type Leaderboard = LeaderboardResponse

export type __scorecardDriftGuard = [
  _statusFwd,
  _statusBack,
  _metricFwd,
  _metricBack,
  _trialFwd,
  _trialBack,
  _stepFwd,
  _stepBack,
  _modelsFwd,
  _modelsBack,
  _exportFwd,
  _exportBack,
  _originFieldsOnWire,
  _recordFieldsOnWire,
  _diffFwd,
  _diffBack,
  _trendFwd,
  _trendBack,
  _lbFwd,
  _lbBack,
]
