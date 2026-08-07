import { z } from "zod";
import { JudgeRunConfigSchema } from "../execution/case-job.js";
import { GraderSpecSchema, ScorecardSchema } from "../execution/eval-case.js";
import { VerdictPolicyRefSchema } from "../execution/verdict-policy.js";

// Scorecard run lifecycle: accept a dataset×harness batch eval → run → success/failure.
// superseded = a terminal state where a newer fire of the same (origin.repo, prNumber, harness, dataset) reclaimed (cancelled·replaced) this batch.
// cancelled = a terminal state where a user explicitly stopped this batch (remaining cases not fired, in-flight runtime jobs force-killed) — a deliberate stop, not a newer fire.
// Both are neither failure nor success, so neither is counted in baseline/diff/leaderboard (succeeded only). The store keeps the record.
export const ScorecardStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "superseded", "cancelled"]);
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
  // Categorical metrics (any score carried a `label`): the label distribution (ordered enum → ordinal order via the
  // scores' `value`, else by frequency) + the most-frequent label (mode). Present ONLY when the metric is categorical
  // — numeric/boolean metrics leave both unset and are read via mean/passRate. `mean` stays populated but is not shown.
  distribution: z.array(z.object({ label: z.string(), count: z.number().int().nonnegative() })).optional(),
  mode: z.string().optional(),
  // Scores of this metric that were NOT measurements (grader error / skip) — excluded from count/mean/passRate/
  // distribution above and surfaced as their own tally so a grader outage is visible instead of shifting the mean.
  // Present only when > 0.
  unmeasured: z.number().int().positive().optional(),
});
export type MetricSummary = z.infer<typeof MetricSummarySchema>;

// Reproducibility manifest — content digests of EXACTLY what this batch evaluated, sealed at submit. The
// registry rows (dataset/harness/graders) keep living; the manifest answers "was it exactly this document?"
// long after. Values are canonical-JSON FNV digests (@everdict/domain contentDigest). mig 0126. Absent on
// pre-manifest batches. trust-kernel contract ⑤.
export const ScorecardManifestSchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string(), digest: z.string() }), // digest over the resolved case bundle
  harness: z.object({ id: z.string(), version: z.string(), specDigest: z.string().optional() }), // resolved spec (absent: built-in with no declarative spec)
  graders: z.string().optional(), // digest of the run-time grading plan (absent = per-case defaults)
});
export type ScorecardManifest = z.infer<typeof ScorecardManifestSchema>;

// The scorecard's denominators (isomorphic to @everdict/domain scorecardOutcomes) — served next to casePass so
// no client conflates 841/970 (verdicted) with 841/1000 (requested). infraFailed cases carry NO product verdict;
// they are recovery work, never product failures. DERIVED on read, never persisted.
export const ScorecardOutcomesSchema = z.object({
  executed: z.number().int().nonnegative(),
  gradeable: z.number().int().nonnegative(),
  verdicted: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  infraFailed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(), // killed mid-case with a result (unlaunched = requested − executed)
  unmeasured: z.number().int().nonnegative(),
  requested: z.number().int().nonnegative().optional(),
});
export type ScorecardOutcomes = z.infer<typeof ScorecardOutcomesSchema>;

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
  // Causation as a first-class edge (execution-model P3): the agent RUN whose action submitted this batch.
  // Children inherit it as origin{cause:"run", causedByRunId} — the demand graph the P4 gate walks.
  causedByRunId: z.string().optional(),
  // The schedule that fired this run (source === "schedule"). Lets a schedule's detail view list its own run
  // history (regression over time) — the only link otherwise is Schedule.lastScorecardId (the latest fire).
  scheduleId: z.string().optional(),
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

// Reserved sentinel id used for a scorecard's `dataset` (and `harness`) when it scores observability traces DIRECTLY —
// the "evaluate existing traces" path (pick traces from a workspace trace source + run judges, no dataset, no harness
// run). It keeps the NOT-NULL dataset/harness columns populated WITHOUT a real registry entry, so no schema migration
// is needed. A leading underscore mirrors the reserved `_shared` tenant convention. Consumers detect a trace-evaluation
// scorecard by `dataset.id === TRACE_EVAL_REF` (this id never collides with a real, registrable dataset id) and render
// it without a dataset/harness deep-link. It also self-excludes from leaderboard/trend, which positively filter by a
// real datasetId. docs/scorecards.md
export const TRACE_EVAL_REF = "_traces";

// The reserved trace-source name that points the PULL machinery at everdict's OWN trajectory store
// (native-observability N2, continuous evaluation): pull-ingest and pull-mode schedules read the sealed
// trajectories directly — no external platform, no re-upload. A workspace source may not take this name.
export const EVERDICT_TRACE_SOURCE = "everdict";

// Reserved sentinel dataset ref for an EXPERIMENT over an ad-hoc task (execution-model.md P1) — "drive this
// harness on a one-off prompt, N times" has no registrable dataset, so the NOT-NULL dataset columns carry
// this sentinel (same convention as TRACE_EVAL_REF). An ad-hoc experiment is NOT re-drivable after a
// control-plane restart (there is no registry entry to re-plan from — the recovery path settles it like a
// pre-caseSpec record); dataset-backed experiments re-drive normally.
export const EXPERIMENT_ADHOC_REF = "_adhoc";

export const ScorecardRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // 이 결과를 만든 팀. 자산과 같은 축이라 "우리 팀이 무엇을 평가했나"를 하네스를 전부 훑지 않고
  // 답할 수 있다. 선택적인 이유는 팀 도입 이전 행과 소유자 없는 실행이 실재하기 때문 — 없음은
  // "모두의 것"이 아니라 "소유자 없음"이다.
  teamId: z.string().optional(),
  // Group kind (execution-model.md P1, decision O3: the RunGroup generalizes ScorecardRecord IN CONCEPT, the
  // table is kept). "experiment" = phase 1 alone — same fan-out, same child runs, NO judges/graders and no
  // verdict pressure (caseVerdict stays undefined; analytics exclude it). Absent = a scorecard (the default);
  // "scorecard" is written EXPLICITLY only when scoring promotes an experiment (P2 — a group with a verdict
  // is definitionally a scorecard).
  kind: z.enum(["scorecard", "experiment"]).optional(),
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
      judge: JudgeRunConfigSchema.optional(), // inline judge model = a Model binding (ref | raw string), same as the job/settings shape
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
  // Object-store ref to the self-contained ANALYSIS artifact (the analysis result as a first-class object): the
  // dataset/harness + aggregate summary + per-case verdict/scores, generated at finalize. Downloadable/shareable/
  // archivable independent of the DB (the analysis-output sibling of the run-output snapshot artifacts). Best-effort —
  // absent when no ArtifactStore is configured or the offload failed.
  analysisRef: z.string().optional(),
  export: ScorecardExportSchema.optional(), // trace-sink export result (for detail — get only, like steps)
  // WHICH verdict policy produced this batch's verdicts (id + version + content digest). Verdicts are derived
  // on read, so this stamp is what keeps a historical verdict stable when the policy evolves: readers resolve
  // the STAMPED policy (resolveVerdictPolicy), never silently the newest one. Absent on batches settled before
  // the stamp existed — those were judged under the authority ladder the default policy encodes. mig 0125.
  verdictPolicy: VerdictPolicyRefSchema.optional(),
  manifest: ScorecardManifestSchema.optional(), // reproducibility digests, sealed at submit (mig 0126)
  // The batch's ASK — cases × trials at submit (ingest: the trace count). The requested−executed gap is the
  // unlaunched/cancelled tally no per-result walk can recover once cases were skipped. mig 0127.
  requested: z.number().int().nonnegative().optional(),
  // Which version of the span→event PROJECTION this batch was judged under (N6,
  // docs/architecture/otel-trace-model.md). Spans are immutable once ended, so the record is stable — but the
  // projection is code, and a verdict nobody can re-derive is a verdict nobody can defend. Storing the version
  // rather than a second copy of the events keeps ONE copy of the truth and still dates the interpretation.
  // Absent on batches judged before N6 (they were scored against events that WERE the record).
  traceProjectionVersion: z.number().int().positive().optional(),
  error: ScorecardRunErrorSchema.optional(),
  steps: z.array(ScorecardStepSchema).optional(), // execution timeline (appended even while in progress)
  // The ids of the child runs this batch fanned out (if any). scorecard = run × N expressed as references — a per-case addressable run drill-down.
  // A lightweight reference separate from the heavy scorecard (embedded results). get only (like steps) — for detail. Unset for past records/ingest paths.
  runIds: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScorecardRecord = z.infer<typeof ScorecardRecordSchema>;
