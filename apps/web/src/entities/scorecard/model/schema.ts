import type {
  ExecutionManifest as WireExecutionManifest,
  MetricSummary as WireMetricSummary,
  Score as WireScore,
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
  // Absent when count is 0 (every score of the metric was unmeasured/invalid) — a mean over nothing is not 0,
  // and rendering it as one is how a dead grader shows up as $0.00.
  mean: z.number().optional(),
  passRate: z.number().optional(),
  // Categorical metrics (scores carried a `label`): label distribution (ordered enum → ordinal, else by frequency) +
  // most-frequent label. Present only when the metric is categorical (tier/string/enum); the dashboard keys off this
  // instead of the mean. Guarded vs the wire.
  distribution: z.array(z.object({ label: z.string(), count: z.number() })).optional(),
  mode: z.string().optional(),
  // Scores of this metric that were NOT measurements (grader error / judge skip) — excluded from count/mean/
  // passRate and tallied here. A zod object strips undeclared keys, so omitting this field here silently
  // amputated the one honest signal about a grader outage before any surface could render it.
  unmeasured: z.number().optional(),
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
// Stays LOCAL: the contract Score's `detail` is `unknown` (prose OR a structured object — code judges emit objects),
// so the schema must accept unknown too; the web narrows at render via fmtScoreDetail (string as-is, else JSON).
export const caseScoreSchema = z
  .object({
    graderId: z.string(),
    metric: z.string(),
    // ABSENT on a non-measurement. The contract's Score is a discriminated union on `status`: an unmeasured or
    // invalid row carries no value at all (there is no placeholder zero left to mis-render), so the field has to
    // be optional here or a dead grader would reject the whole scorecard at parse.
    value: z.number().optional(),
    pass: z.boolean().optional(),
    label: z.string().optional(), // categorical value (tier/string) — shown instead of `value` when present
    detail: z.unknown().optional(),
    // Measurement status (contract: "measured" | "unmeasured" | "invalid"; absent = measured). Loose string so a
    // future status never rejects the scorecard; isUnmeasuredScore reads it as the discriminant and fails closed.
    status: z.string().optional(),
    reason: z.string().optional(),
    // unmeasured only: true ⇒ re-scoring this grader can recover the measurement (the rescore worklist reads it).
    retryable: z.boolean().optional(),
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
    // The verdict's audit trail — which rung decided, under which aggregation, from which measurements. Loose
    // local view (enums stay strings so a new authority never rejects the scorecard).
    verdictBasis: z
      .object({
        authority: z.string(),
        aggregation: z.string(),
        deciders: z.array(
          z.object({ metric: z.string(), graderId: z.string(), pass: z.boolean() }).passthrough()
        ),
      })
      .passthrough()
      .optional(),
    // Evidence completeness per case — a verdict standing on partial evidence says so.
    evidenceStatus: z.object({ trace: z.string(), snapshot: z.string() }).passthrough().optional(),
    // The world this case actually ran in (execution manifest) — os + whether the case authored it, plus the
    // driver/image/runtime that produced the compute. Absent = the producer recorded no world (a synthesized
    // dispatch failure, an ingested trace); the UI hides the strip rather than inventing linux. Loose local
    // view: os stays a string so a new world never rejects the whole scorecard.
    execution: z
      .object({
        os: z.string(),
        osResolved: z.string(),
        driver: z.string().optional(),
        image: z.string().optional(),
        runtime: z.string().optional(),
      })
      .passthrough()
      .optional(),
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
        domRef: z.string().optional(), // full page DOM offloaded to object storage (dom = inline preview)
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
  // The owning team (mig 0106). It decides who may CHANGE this and — for a private team — who sees it at
  // all, and it is re-fileable (`POST /<resource>/:id/team`), so the detail shows it and offers the move.
  // Absent = unowned (a `_shared` entry, or one from before the axis), which is the workspace's.
  teamId: z.string().optional(),
  runtime: z.string().optional(), // the runtime the batch ran on (placement.target: registered runtime id | self:* runner). Unset = legacy·ingest records. Lightweight → also included in the list.
  // Batch-on-Temporal ownership — when set, a durable workflow drives this batch (shown as a chip on the detail).
  orchestration: z
    .object({
      workflowId: z.string().optional(),
      // The Agent Judges (entity refs) applied to this batch — surfaced as clickable entity links on the detail.
      judges: z.array(z.object({ id: z.string(), version: z.string() })).optional(),
    })
    .passthrough()
    .optional(),
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
  // Server-computed authority-ranked headline (list + detail) — prefer this over any summary-order heuristic.
  headlinePassRate: z.number().nullable().optional(),
  // Server-computed rollup of per-case verdicts (detail only) — replaces the deleted client-side casePass mirror.
  casePass: z.object({ pass: z.number().int(), total: z.number().int() }).optional(),
  // Transient scoring failures a targeted re-score can recover (detail only) — the rescore button shows iff set.
  retryableUnmeasured: z.number().int().optional(),
  // Server-computed case-fate denominators (detail only): an infra-failed case carries NO product verdict — it is
  // recovery work, never a product failure — so pass rate reads passed/verdicted, never passed/executed.
  outcomes: z
    .object({
      executed: z.number().int(),
      gradeable: z.number().int(),
      verdicted: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      infraFailed: z.number().int(),
      cancelled: z.number().int(), // killed mid-case with a result (unlaunched = requested − executed)
      unmeasured: z.number().int(),
      requested: z.number().int().optional(),
    })
    .optional(),
  // WHICH verdict policy produced this batch's verdicts — the stamp that keeps a historical verdict stable
  // when the policy evolves. Absent on batches settled before the stamp existed.
  verdictPolicy: z.object({ id: z.string(), version: z.string(), digest: z.string() }).optional(),
  // Whether that stamp could be RESTORED at serve time (detail only). 'unresolvable' = the stamped document
  // is gone, so the server withholds every verdict-derived field (per-case verdict, casePass, outcomes)
  // rather than re-judge the batch under today's ladder — the UI must show the absence, never a 0%.
  policyResolution: z.enum(['resolved', 'legacy_default', 'unresolvable']).optional(),
  // Reproducibility digests sealed at submit (detail only). Loose local view — the web renders it, never
  // re-derives from it.
  manifest: z
    .object({
      dataset: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
      harness: z
        .object({ id: z.string(), version: z.string(), specDigest: z.string().optional() })
        .passthrough(),
      graders: z.string().optional(),
      judges: z
        .array(
          z
            .object({ id: z.string(), version: z.string(), specDigest: z.string().optional() })
            .passthrough()
        )
        .optional(),
    })
    .passthrough()
    .optional(),
  // The batch's ASK — cases × trials at submit. requested − executed is the unlaunched/cancelled tally.
  requested: z.number().int().optional(),
  // Object-store ref to the self-contained analysis artifact (summary + per-case verdict/scores) — downloadable/shareable
  // independent of the DB. Best-effort at finalize; absent when no object store is configured.
  analysisRef: z.string().optional(),
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
  method: z.enum(['z', 'fisher']), // small samples decide by Fisher's exact test, not the z approximation
  p: z.number(), // two-sided p of this case's test — Fisher's exact p, or the normal-tail p of z on the z branch
  significant: z.boolean(), // statistically significant AND |delta| >= minDelta
  // Cleared its own alpha but did not survive the Benjamini–Hochberg correction across the batch's cases:
  // significant before correction, not after. Never silently dropped — the row says it was suppressed.
  fdrSuppressed: z.boolean().optional(),
})

// Statistically-gated diff — attached to the diff response when either side ran trials (regressions are the
// significant pass-rate drops, not single flips). docs/architecture/trial-based-verdict.md
export const trialDiffSchema = z.object({
  baseline: z.string(),
  candidate: z.string(),
  zThreshold: z.number(),
  minDelta: z.number(), // practical-significance floor — significant drops smaller than this stay out of the gate
  // The Benjamini–Hochberg false-discovery level applied across these cases' tests. Absent = no correction ran,
  // which is why a row's fdrSuppressed is only readable next to it: suppressed AT WHAT LEVEL is the question.
  fdrAlpha: z.number().optional(),
  cases: z.array(trialCaseDeltaSchema),
  regressions: z.array(trialCaseDeltaSchema),
  improvements: z.array(trialCaseDeltaSchema),
  missing: z.object({
    casesOnlyInBaseline: z.array(z.string()),
    casesOnlyInCandidate: z.array(z.string()),
    unscoredCases: z.array(z.string()),
  }),
})

export const scorecardDiffSchema = z.object({
  baseline: z.string(),
  candidate: z.string(),
  // Metrics present on BOTH sides only — one-sided metrics are enumerated in `missing`, never zero-filled.
  metrics: z.array(
    z.object({
      metric: z.string(),
      baselineMean: z.number(),
      candidateMean: z.number(),
      delta: z.number(),
      direction: z.enum(['higher_is_better', 'lower_is_better', 'neutral']).optional(),
      // The delta interpreted through the declared direction — never generalize delta>0 as improvement.
      reading: z.enum(['improved', 'regressed', 'unchanged', 'unknown']),
    })
  ),
  // Metric-level pass flips — diagnosis of why a case moved; the regression unit gates count is caseTransitions.
  regressions: z.array(caseDeltaSchema),
  improvements: z.array(caseDeltaSchema),
  // Case-VERDICT transitions over shared (case, trial) pairs, each side judged under its own stamped policy —
  // the unit release decisions are made in ('unmeasured' = a side produced no verdict; never a regression).
  caseTransitions: z.array(
    z.object({
      caseId: z.string(),
      trial: z.number().int().optional(),
      baseline: z.boolean().optional(),
      candidate: z.boolean().optional(),
      change: z.enum(['broke', 'fixed', 'same', 'unmeasured']),
    })
  ),
  // A side's stamped policy could not be restored → NO transitions were computed (unknown policy means
  // unknown verdict) — an empty caseTransitions with this marker is a different claim from "no case moved".
  transitionsUnavailable: z.enum(['baseline', 'candidate', 'both']).optional(),
  // Per-metric measurement coverage of each side — measured rows / outcome-bearing rows. A coverage drop
  // (rows a grader silently never emitted) downgrades comparability to partial.
  metricCoverage: z.array(
    z.object({
      metric: z.string(),
      baselineCases: z.number().int(),
      baselineMeasured: z.number().int(),
      candidateCases: z.number().int(),
      candidateMeasured: z.number().int(),
    })
  ),
  // What could NOT be compared — a first-class output, never a silent skip.
  missing: z.object({
    casesOnlyInBaseline: z.array(z.string()),
    casesOnlyInCandidate: z.array(z.string()),
    metricsOnlyInBaseline: z.array(z.string()),
    metricsOnlyInCandidate: z.array(z.string()),
  }),
  // Same-name metrics whose value kind changed between sides — excluded from metrics, never a readable delta.
  incomparable: z.array(z.object({ metric: z.string(), reason: z.literal('kind_changed') })),
  overlap: z.object({
    sharedCases: z.number().int(),
    baselineCases: z.number().int(),
    candidateCases: z.number().int(),
  }),
  // 'none' = the comparison does not hold — a different claim from 'no differences'. Read this FIRST.
  comparability: z.enum(['full', 'partial', 'none']),
  policyMismatch: z
    .object({
      baseline: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
      candidate: z.object({ id: z.string(), version: z.string(), digest: z.string() }),
    })
    .optional(),
  // A side whose stamped verdict policy could not be restored — its verdicts are not re-derivable, so the
  // comparison does not hold (comparability forced to 'none').
  policyUnresolvable: z
    .object({
      baseline: z.object({ id: z.string(), version: z.string(), digest: z.string() }).optional(),
      candidate: z.object({ id: z.string(), version: z.string(), digest: z.string() }).optional(),
    })
    .optional(),
  // Experiment identity — the two reproducibility manifests read against each other. `held` = verified
  // identical; `confounds` = VERIFIED different (a different experiment — the gate refuses unless the axis is
  // acknowledged); `unverified` = nothing to verify against (unsealed side / digest-era gap) — informational.
  experiment: z
    .object({
      held: z.array(z.enum(['dataset_content', 'grading_plan', 'judge_set', 'harness_model'])),
      confounds: z.array(
        z.object({
          axis: z.enum(['dataset_content', 'grading_plan', 'judge_set', 'harness_model']),
          detail: z.string(),
        })
      ),
      unverified: z.array(
        z.object({
          axis: z.enum(['dataset_content', 'grading_plan', 'judge_set', 'harness_model']),
          // 'composite' = a pre-split seal (one bundle digest over content × selection × grading) differs —
          // which of the three moved is indistinguishable, so neither sameness nor difference is claimable.
          reason: z.enum(['unsealed', 'digest_era', 'composite']),
          detail: z.string(),
        })
      ),
    })
    .optional(),
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
  policyDiffers: z.boolean().optional(), // different policy than the baseline point — never regressed
})

export const scorecardTrendSchema = z.object({
  dataset: z.string(),
  metric: z.string(),
  baseline: z.string(),
  // Reading direction the server computed regressions under — absent = unknown: deltas stay uncolored.
  direction: z.enum(['higher_is_better', 'lower_is_better']).optional(),
  policyMixed: z.boolean().optional(), // mixed verdict policies — cross-policy regressions are suppressed
  points: z.array(trendPointSchema),
})

// GET /scorecards/leaderboard response: (harness × model) ranking for one dataset (benchmark) (metric descending).
export const leaderboardRowSchema = z.object({
  rank: z.number(),
  harness: z.object({ id: z.string(), version: z.string() }),
  model: z.string().optional(),
  modelUnknown: z.boolean().optional(), // no model recorded — folded unknowns; fair-compare with care
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
  policyMixed: z.boolean().optional(), // ranked under different verdict policies — ordering is cross-policy
  rows: z.array(leaderboardRowSchema),
})

// Drift guards.
type AssertAssignable<A extends B, B> = A
// Assignability alone cannot catch a MISSING OPTIONAL field (width subtyping accepts it in both directions) —
// which is exactly how `MetricSummary.unmeasured` was silently stripped at parse while the re-exported type
// claimed it existed. For sub-types declared IDENTICAL to the contract, additionally assert key-set equality.
type AssertSameKeys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [
  never,
  never,
]
  ? true
  : { missingFromWeb: Exclude<keyof B, keyof A>; extraOnWeb: Exclude<keyof A, keyof B> }
type AssertTrue<T extends true> = T
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
type _metricKeys = AssertTrue<AssertSameKeys<WebMetricSummary, WireMetricSummary>>
type _trialFwd = AssertAssignable<WebScorecardTrialSummary, WireScorecardTrialSummary>
type _trialBack = AssertAssignable<WireScorecardTrialSummary, WebScorecardTrialSummary>
type _trialKeys = AssertTrue<AssertSameKeys<WebScorecardTrialSummary, WireScorecardTrialSummary>>
type _stepFwd = AssertAssignable<WebScorecardStep, WireScorecardStep>
type _stepBack = AssertAssignable<WireScorecardStep, WebScorecardStep>
type _modelsFwd = AssertAssignable<WebScorecardModels, WireScorecardModels>
type _modelsBack = AssertAssignable<WireScorecardModels, WebScorecardModels>
type _exportFwd = AssertAssignable<WebScorecardExport, WireScorecardExport>
type _exportBack = AssertAssignable<WireScorecardExport, WebScorecardExport>
type _stepKeys = AssertTrue<AssertSameKeys<WebScorecardStep, WireScorecardStep>>
type _modelsKeys = AssertTrue<AssertSameKeys<WebScorecardModels, WireScorecardModels>>
type _exportKeys = AssertTrue<AssertSameKeys<WebScorecardExport, WireScorecardExport>>
// Score.detail is `unknown` on the wire (structured verdict objects, not just prose) — the local view must
// accept it, or a single object detail rejects the whole scorecard at parse time. Regression guard.
type _scoreDetailAccepts = AssertAssignable<
  WireScore['detail'],
  z.infer<typeof caseScoreSchema>['detail']
>
// EVERY variant of the wire's Score union must fit this local view — the guard is what keeps `value`
// optional here from drifting back to required (which would reject an unmeasured row) and what will fail
// the web build if a variant grows a field the display needs.
type _scoreAcceptsEveryVariant = AssertAssignable<WireScore, z.infer<typeof caseScoreSchema>>
// The execution manifest the control plane serves must fit this local view — the guard fails the web build
// if a field is retyped. It CANNOT catch a newly ADDED optional field (still assignable both ways), which is
// why schema.test.ts parses a full manifest and asserts what survived.
type _executionAccepts = AssertAssignable<
  WireExecutionManifest,
  NonNullable<z.infer<typeof caseResultSchema>['execution']>
>
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
  _metricKeys,
  _trialFwd,
  _trialBack,
  _trialKeys,
  _stepFwd,
  _stepBack,
  _stepKeys,
  _modelsFwd,
  _modelsBack,
  _modelsKeys,
  _exportFwd,
  _exportBack,
  _exportKeys,
  _scoreDetailAccepts,
  _originFieldsOnWire,
  _recordFieldsOnWire,
  _diffFwd,
  _diffBack,
  _trendFwd,
  _trendBack,
  _lbFwd,
  _lbBack,
]
