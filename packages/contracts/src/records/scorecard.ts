import { z } from "zod";
import { GraderSpecSchema, ScorecardSchema } from "../execution/eval-case.js";

// Scorecard run lifecycle: accept a dataset×harness batch eval → run → success/failure.
// superseded = a terminal state where a newer fire of the same (origin.repo, prNumber, harness, dataset) reclaimed (cancelled·replaced) this batch —
// neither failure nor success, so it's not counted in baseline/diff/leaderboard (succeeded only). The store keeps this record.
export const ScorecardStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "superseded"]);
export type ScorecardStatus = z.infer<typeof ScorecardStatusSchema>;

// phase = the failed pipeline stage (dispatch|judges|metrics|offload|persist) — for "at which stage" diagnosis (jsonb, so no migration needed).
export const ScorecardRunErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  phase: z.string().optional(),
});

// Per-metric aggregate (isomorphic to @everdict/domain summarizeScorecard's result). The record shape is the SSOT here in contracts; domain computes it.
export const MetricSummarySchema = z.object({
  metric: z.string(),
  count: z.number(),
  mean: z.number(),
  passRate: z.number().optional(),
});
export type MetricSummary = z.infer<typeof MetricSummarySchema>;

// Trial-based verdict roll-up (pass@k / flakiness) — isomorphic to @everdict/domain summarizeTrials's result (shape
// mirror only; db depends on core, not suite). DERIVED on read from the scorecard's repeated trials (like
// RunRecord.usage from the trace) — never persisted; present only on a multi-trial batch's detail. docs/architecture/trial-based-verdict.md
export const ScorecardTrialSummarySchema = z.object({
  cases: z.number(), // cases with >=1 scored trial
  minTrials: z.number(),
  maxTrials: z.number(),
  passAt1: z.number(), // mean over cases of the per-case pass rate
  k: z.number(), // the k used for passAtK
  passAtK: z.number(),
  flakyCases: z.number(), // cases with mixed pass/fail across trials
  flakeRate: z.number(),
});
export type ScorecardTrialSummary = z.infer<typeof ScorecardTrialSummarySchema>;

// The models this run actually used (leaderboard model axis, isomorphic to @everdict/domain scorecardModels's result — shape mirror only).
// observed = observed from the trace · declared = declared in the spec · primary = group key (observed first, else declared). Lightweight, so included in list too.
export const ScorecardModelsSchema = z.object({
  observed: z.array(z.string()).default([]),
  declared: z.string().optional(),
  primary: z.string().optional(),
});
export type ScorecardModels = z.infer<typeof ScorecardModelsSchema>;

// The trigger provenance of this scorecard run — where it was fired from (schedule|github-actions|api|web…) + commit coordinates.
// A GitHub Actions PR fire records the submit-time ephemeral pins (pinOverrides: slot→image) here — the registry is unchanged, so
// this field is the reproducibility basis for "what it was evaluated with". Lightweight → included in list too. Pg is origin jsonb (mig 0033, additive).
export const ScorecardOriginSchema = z.object({
  source: z.string(), // schedule|github-actions|api|web…
  repo: z.string().optional(), // "owner/name"
  sha: z.string().optional(),
  ref: z.string().optional(), // refs/heads/… | refs/pull/…
  prNumber: z.number().int().optional(),
  runUrl: z.string().optional(), // CI run link
  pinOverrides: z.record(z.string()).optional(), // submit-time ephemeral pins (slot→image) — records the PR image swap
  // Lineage of a retry-failed run — the source scorecard this record re-ran the failed cases of (passing results
  // carried over verbatim). The source record itself is never mutated. docs/architecture/batch-resilience.md
  retryOf: z.string().optional(),
  // OOM escalation state (per case, Mb) — the memory this retry ran the case with after doubling on OOM_KILLED.
  // The next retry reads it as its base, so repeated retries compound (64 → 128 → 256 …) up to the cap. The
  // registry spec itself is never mutated — the boost rides the job only. docs/architecture/batch-resilience.md
  memoryBoostMb: z.record(z.number()).optional(),
});
export type ScorecardOrigin = z.infer<typeof ScorecardOriginSchema>;

// Execution steps (timeline) — appended as the run progresses to show "progress" (incremental store).
// phase = dispatch|judges|metrics|offload|persist|case, status = started|ok|failed|info.
// Pg is a steps jsonb column (mig 0026, additive). Heavy detail, so it's omitted from list and returned only in get.
export const ScorecardStepSchema = z.object({
  ts: z.string(),
  phase: z.string(),
  status: z.enum(["started", "ok", "failed", "info"]),
  message: z.string(),
  caseId: z.string().optional(),
});
export type ScorecardStep = z.infer<typeof ScorecardStepSchema>;

// Partial run (subset) — which subset of the dataset this batch ran. Unset = full run.
// The marker is what lets consumers (list/detail/diff/leaderboard) know "this is not the full result". Lightweight → included in list too. mig 0043.
export const ScorecardSubsetSchema = z.object({
  total: z.number().int().nonnegative(), // total case count of the dataset at submit time
  selected: z.number().int().nonnegative(), // number of cases actually run
  ids: z.array(z.string()).optional(), // explicitly selected case ids
  tags: z.array(z.string()).optional(), // tag filter (any-match)
  limit: z.number().int().positive().optional(), // first N after applying the filter
});
export type ScorecardSubset = z.infer<typeof ScorecardSubsetSchema>;

// Trace-sink export result — the record of exporting per-case trace+scores to the workspace observability platform after scoring completes.
// A failure does not affect the scorecard status (status lives only here). Preserves per-case external trace ids/links
// (so the pull-ingest runs mapping doesn't get lost). Pg is sink_export jsonb (mig 0048, additive).
// Design: docs/architecture/trace-sink.md
export const ScorecardExportSchema = z.object({
  sink: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
  name: z.string().optional(), // the sink name used (which one among multiple sinks — unset for past records)
  status: z.enum(["succeeded", "partial", "failed"]),
  url: z.string().optional(), // top-level (experiment/project) deep link
  message: z.string().optional(), // failure/partial reason
  exportedAt: z.string(),
  cases: z
    .array(
      z.object({
        caseId: z.string(),
        externalId: z.string().optional(), // platform trace/run id (the target created or attached)
        url: z.string().optional(), // case trace deep link
        error: z.string().optional(), // per-case failure (isolated — other cases keep exporting)
      }),
    )
    .optional(),
});
export type ScorecardExport = z.infer<typeof ScorecardExportSchema>;

export const ScorecardRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }), // resolved concrete version (never "latest")
  status: ScorecardStatusSchema,
  summary: z.array(MetricSummarySchema).optional(), // lightweight aggregate (for listing)
  // Trial roll-up (pass@k / flakiness) — DERIVED on get() from the scorecard's repeated trials, never stored (like
  // RunRecord.usage). Present only when the batch ran trials>1. docs/architecture/trial-based-verdict.md
  trialSummary: ScorecardTrialSummarySchema.optional(),
  // Remaining wall-clock estimate (seconds) — DERIVED on get() for a RUNNING batch from its own finished
  // children (median duration × remaining / concurrency). Never stored. docs/architecture/work-queue.md
  etaSeconds: z.number().optional(),
  models: ScorecardModelsSchema.optional(), // the models this run used (leaderboard axis, lightweight → included in list too). Unset for past records.
  // The judge model(s) that scored this run — if the model axis is 'the LLM the harness used', this is the 'grader'. Filter/display
  // for fair comparison (same judge). Distinct of inline judge config.model + registered model-judge spec.model. Lightweight → included in list too.
  judgeModels: z.array(z.string()).optional(),
  origin: ScorecardOriginSchema.optional(), // trigger provenance — lightweight, so included in list too. Unset for past records.
  // Runner (submitter subject) — to show/filter "who ran it" (avatar+name). If origin.source is 'where', this is 'who'.
  // Same pattern as datasets/harnesses' created_by. Unset for past records and machine-fired runs (no subject). Lightweight → included in list too.
  createdBy: z.string().optional(),
  // The runtime it was placed on (placement.target) — the work-queue's "where does it run" axis. Unset = default backend. mig 0040.
  runtime: z.string().optional(),
  subset: ScorecardSubsetSchema.optional(), // partial-run marker (unset for a full run)
  // Orchestration inputs needed to re-drive this batch after the fact (restart resume / retry-failed):
  // selected Agent Judges + inline judge model + concurrency + transient-retry count. Persisted at submit
  // (mig 0049); records without it (pre-field) cannot be faithfully resumed. docs/architecture/batch-resilience.md
  orchestration: z
    .object({
      judges: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
      // Run-time grading plan — replaced every case's default graders at submit; persisted so resume/retry/
      // workflow re-plans score exactly like the original. docs/architecture/eval-domain-model.md S5
      graders: z.array(GraderSpecSchema).optional(),
      judge: z.object({ provider: z.enum(["openai", "anthropic"]).optional(), model: z.string() }).optional(),
      concurrency: z.number().int().positive(),
      retries: z.number().int().min(0).default(0),
      // Run each case N times for pass@k / flakiness. Absent = 1 (single run). Persisted so a re-drive keeps the
      // trial count. docs/architecture/trial-based-verdict.md
      trials: z.number().int().positive().optional(),
      // Set when a Temporal workflow owns this batch's driver loop — boot recovery leaves such batches alone
      // (they own themselves) and the web can deep-link the workflow. docs/architecture/temporal-batch-orchestration.md
      workflowId: z.string().optional(),
      // Per-batch trace-sink override — a configured sink name, or "none" to suppress export for this batch.
      // Persisted so resume/retry keep the same destination. docs/architecture/trace-sink.md
      traceSink: z.string().optional(),
      // In-batch OOM auto-boost (opt-in) — an OOM_KILLED case re-dispatches inside the batch with doubled
      // job-only memory up to the cap. Persisted so resume keeps the behavior. docs/architecture/batch-resilience.md
      oomAutoBoost: z.boolean().optional(),
    })
    .optional(),
  scorecard: ScorecardSchema.optional(), // full per-case results (for detail, heavy)
  export: ScorecardExportSchema.optional(), // trace-sink export result (for detail — get only, like steps)
  error: ScorecardRunErrorSchema.optional(),
  steps: z.array(ScorecardStepSchema).optional(), // execution timeline (appended even while in progress)
  // The ids of the child runs this batch fanned out (if any). scorecard = run × N expressed as references — a per-case addressable run drill-down.
  // A lightweight reference separate from the heavy scorecard (embedded results). get only (like steps) — for detail. Unset for past records/ingest paths.
  runIds: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScorecardRecord = z.infer<typeof ScorecardRecordSchema>;
