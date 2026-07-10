import { z } from 'zod'

// Client mirror of the control plane ScorecardRecord. The web couples over HTTP only — no backend package dependency.
export const scorecardStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'superseded',
])
export type ScorecardStatus = z.infer<typeof scorecardStatusSchema>

// per-metric aggregation (shared by list/detail).
export const metricSummarySchema = z.object({
  metric: z.string(),
  count: z.number(),
  mean: z.number(),
  passRate: z.number().optional(),
})
export type MetricSummary = z.infer<typeof metricSummarySchema>

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
export type ScorecardTrialSummary = z.infer<typeof scorecardTrialSummarySchema>

// per-case scores (loose — display fields only, the rest passthrough). detail = the grader/judge's verdict rationale (VLM rubric reasoning, etc.).
export const caseScoreSchema = z
  .object({
    graderId: z.string(),
    metric: z.string(),
    value: z.number(),
    pass: z.boolean().optional(),
    detail: z.string().optional(),
  })
  .passthrough()

// trace events (loose) — display only looks at error events (case failure reasons). The rest passthrough.
export const traceEventSchema = z
  .object({ kind: z.string(), message: z.string().optional() })
  .passthrough()

export const caseResultSchema = z
  .object({
    caseId: z.string(),
    harness: z.string().optional(),
    verdict: z.boolean().optional(), // server-computed case verdict (authority rank) — served, never recomputed here
    scores: z.array(caseScoreSchema).default([]),
    trace: z.array(traceEventSchema).default([]), // case execution trace — error events expose the failure spans

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

// the full scorecard for GET /scorecards/:id (including per-case results).
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
export type ScorecardStep = z.infer<typeof scorecardStepSchema>

// the models this run actually used (leaderboard model axis). observed=trace-observed, declared=spec-declared, primary=representative (observed first).
export const scorecardModelsSchema = z.object({
  observed: z.array(z.string()).default([]),
  declared: z.string().optional(),
  primary: z.string().optional(),
})
export type ScorecardModels = z.infer<typeof scorecardModelsSchema>

// this run's trigger provenance — where it was fired from (github-actions|schedule|api|web) + commit coordinates.
// A GitHub Actions PR fire records a submit-time ephemeral pin (pinOverrides: slot→image) here (registry unchanged). Lightweight → also included in the list.
export const scorecardOriginSchema = z.object({
  source: z.string(),
  repo: z.string().optional(), // "owner/name"
  sha: z.string().optional(),
  ref: z.string().optional(), // refs/heads/… | refs/pull/…
  prNumber: z.number().optional(),
  runUrl: z.string().optional(), // CI run link
  pinOverrides: z.record(z.string(), z.string()).optional(), // submit-time ephemeral pin (slot→image)
})
export type ScorecardOrigin = z.infer<typeof scorecardOriginSchema>

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
export type ScorecardExport = z.infer<typeof scorecardExportSchema>

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
export type ScorecardRecord = z.infer<typeof scorecardRecordSchema>
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
export type CaseDelta = z.infer<typeof caseDeltaSchema>

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
export type TrialCaseDelta = z.infer<typeof trialCaseDeltaSchema>

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
export type TrialDiff = z.infer<typeof trialDiffSchema>

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
export type ScorecardDiff = z.infer<typeof scorecardDiffSchema>

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
export type TrendPoint = z.infer<typeof trendPointSchema>

export const scorecardTrendSchema = z.object({
  dataset: z.string(),
  metric: z.string(),
  baseline: z.string(),
  points: z.array(trendPointSchema),
})
export type ScorecardTrend = z.infer<typeof scorecardTrendSchema>

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
export type LeaderboardRow = z.infer<typeof leaderboardRowSchema>

export const leaderboardSchema = z.object({
  dataset: z.string(),
  metric: z.string(),
  window: z.enum(['latest', 'best']),
  rows: z.array(leaderboardRowSchema),
})
export type Leaderboard = z.infer<typeof leaderboardSchema>
