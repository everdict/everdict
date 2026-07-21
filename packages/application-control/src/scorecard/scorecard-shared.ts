import {
  type AgentJob,
  AppError,
  BadRequestError,
  type CaseResult,
  type Dataset,
  EnvSnapshotSchema,
  type EvalCase,
  type Grader,
  type GraderSpec,
  type HarnessSpec,
  type JudgeRunConfig,
  NotFoundError,
  type RegistryAuth,
  ScoreSchema,
  type ScorecardExport,
  type ScorecardOrigin,
  type ScorecardRecord,
  type ScorecardSubset,
  type SpanAttrMapping,
  TraceEventSchema,
  TraceEvidenceSchema,
  type TraceSource,
  type TraceSourceConfig,
} from "@everdict/contracts";
import type { BudgetTracker, CircuitBreaker, HarnessSecretMaps, UsageMeter } from "@everdict/domain";
import { z } from "zod";
import type { ExecuteCaseDeps } from "../execution/execute-case.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import { offloadSnapshot } from "../ports/artifact-store.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { Dispatcher } from "../ports/dispatcher.js";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner } from "../ports/judge-runner.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { CaseExportStream } from "../trace-sink/trace-sink-service.js";

// Resolving a registered harness's declarative spec fails two very different ways, and the caller must NOT treat them
// alike. NotFoundError = the id/version isn't in the registry: a built-in harness (scripted/claude-code) or an
// unregistered one — correct to proceed with NO spec embedded (the agent knows it by id). Any OTHER error means the
// harness IS registered but its spec failed to resolve (a malformed target/delivery, a bad pin, a missing template).
// Silently swallowing that would dispatch the eval with no harness, or (worse) let an invalid spec reach the runner
// as an opaque "malformed job" — so it is surfaced as a clear 400 at submit/retry instead. `resolve` is a thunk so
// callers pass get() or resolveWithPins(); an undefined return = the built-in / as-given path.
export async function embedHarnessSpec(
  resolve: () => Promise<HarnessSpec>,
  harness: { id: string; version: string },
): Promise<HarnessSpec | undefined> {
  try {
    return await resolve();
  } catch (e) {
    if (e instanceof NotFoundError) return undefined; // not registered → built-in / as-given (no spec embedded)
    if (e instanceof AppError) throw e; // already a typed, client-safe error (e.g. a missing/mismatched pin)
    // A raw resolve failure (e.g. a ZodError from the spec schema) — remap to our error model so monitoring blames us.
    throw new BadRequestError(
      "BAD_REQUEST",
      { harness: `${harness.id}@${harness.version}` },
      `Harness '${harness.id}@${harness.version}' is registered but its spec is invalid: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// One-line trace-sink export result — for progress-step messages (success/partial/failure + reason).
export function exportStepMessage(e: ScorecardExport): string {
  if (e.status === "succeeded") return `Trace sink (${e.sink}) export complete — ${e.cases?.length ?? 0} case(s)`;
  const label = e.status === "partial" ? "partial export" : "export failed";
  return `Trace sink (${e.sink}) ${label}${e.message ? ` — ${e.message}` : ""}`;
}

// Child-run key for a (case, trial) pair — a batch with trials>1 fans N children per case, so caseId alone is
// ambiguous. trial absent (single-run) collapses to "<caseId>#0", so single-run keying is byte-identical.
// docs/architecture/trial-based-verdict.md
export function childKey(caseId: string, trial?: number): string {
  return `${caseId}#${trial ?? 0}`;
}

// One-line case failure/verdict reason — for progress-step messages. Prefer trace error events over a pass:false score.detail. Truncate if long.
export function caseReason(r: CaseResult): string | undefined {
  const errEvent = r.trace.find((e) => e.kind === "error");
  const raw =
    errEvent && "message" in errEvent
      ? errEvent.message
      : r.scores.find((s) => s.pass === false && typeof s.detail === "string")?.detail;
  if (typeof raw !== "string" || raw === "") return undefined;
  return raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
}

// Trace-ingest body — upload traces already produced externally without running the harness (edge-normalized: TraceEvent[] upload).
// dataset/harness serve as labels and refs (caseId↔task alignment, diff alignment). Validated at the boundary with TraceEventSchema.
export const IngestScorecardBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  traces: z
    .array(
      z.object({
        caseId: z.string(),
        trace: z.array(TraceEventSchema),
        snapshot: EnvSnapshotSchema.optional(),
        evidence: TraceEvidenceSchema.optional(), // pulled-trace evidence (mapping slots) — carries custom judge slots
        scores: z.array(ScoreSchema).optional(),
      }),
    )
    .min(1),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
});
export type IngestScorecardBody = z.infer<typeof IngestScorecardBodySchema>;
export type IngestScorecardInput = IngestScorecardBody & {
  tenant: string;
  submittedBy?: string; // submitter subject → record createdBy (runner attribution/filter)
  origin?: ScorecardOrigin;
};

// pull-ingest body — pull per-runId traces from the tenant's OTel/MLflow and score them (harness not run).
// The source is EITHER a registered workspace trace source referenced by name ("register once, pull by name" — the
// low-friction path) OR an inline ad-hoc config. Named: credential/kind/endpoint come from the pool; inline: credentials
// come only via the authSecret name (SecretStore) — no plaintext token in the spec.
export const PullIngestBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({ id: z.string(), version: z.string().default("latest") }),
  source: z.union([
    // a registered workspace source (Settings › Observability) — the whole connection is already stored under this name.
    z.object({ name: z.string().min(1) }),
    z.object({
      kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
      endpoint: z.string().url(),
      // SecretStore key name → its value used as the credential. otel/mlflow use the Authorization header verbatim (scheme included:
      // "Bearer …"|"Basic …"); for langfuse/langsmith/phoenix the adapter places it in the platform's conventional header (langsmith=x-api-key).
      authSecret: z.string().optional(),
      project: z.string().optional(), // required for phoenix span-lookup path (project name/ID). Ignored for other kinds.
    }),
  ]),
  runs: z.array(z.object({ caseId: z.string(), runId: z.string() })).min(1),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
});
export type PullIngestBody = z.infer<typeof PullIngestBodySchema>;
export type PullIngestInput = PullIngestBody & {
  tenant: string;
  submittedBy?: string; // submitter subject → record createdBy (runner attribution/filter)
  origin?: ScorecardOrigin;
};

// principal.via → origin.source mapping — submission-path provenance (where it was fired from).
// oidc=human (web UI token), github-actions=CI OIDC federation, else (api-key/runner)=api. Scheduled fires stamp "schedule" directly.
export function originSource(via: string): string {
  if (via === "oidc") return "web";
  if (via === "github-actions") return "github-actions";
  return "api";
}

// Partial-run selection — apply ids (explicit) → tags (any-match) → limit (first N) in order. Pure function (easy to test).
// A nonexistent id silently yielding an empty result would be a "ran a subset but looks like the whole thing" hazard, so reject immediately with 400.
export function selectSubsetCases(
  dataset: Dataset,
  sel?: { ids?: string[]; tags?: string[]; limit?: number },
): { cases: Dataset["cases"]; subset?: ScorecardSubset } {
  if (!sel || (!sel.ids?.length && !sel.tags?.length && sel.limit === undefined)) return { cases: dataset.cases };
  let cases = dataset.cases;
  if (sel.ids && sel.ids.length > 0) {
    const want = new Set(sel.ids);
    const have = new Set(cases.map((c) => c.id));
    const missing = [...want].filter((id) => !have.has(id));
    if (missing.length > 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { dataset: dataset.id, missing },
        `Case ids not in the dataset: ${missing.join(", ")}`,
      );
    cases = cases.filter((c) => want.has(c.id));
  }
  if (sel.tags && sel.tags.length > 0) {
    const want = new Set(sel.tags);
    cases = cases.filter((c) => (c.tags ?? []).some((t) => want.has(t)));
  }
  if (sel.limit !== undefined) cases = cases.slice(0, sel.limit);
  if (cases.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { dataset: dataset.id, ...sel },
      "No cases match the selection (check tags/limit).",
    );
  return {
    cases,
    subset: {
      total: dataset.cases.length,
      selected: cases.length,
      ...(sel.ids && sel.ids.length > 0 ? { ids: sel.ids } : {}),
      ...(sel.tags && sel.tags.length > 0 ? { tags: sel.tags } : {}),
      ...(sel.limit !== undefined ? { limit: sel.limit } : {}),
    },
  };
}

// Run-time grading plan (docs/architecture/eval-domain-model.md S5) — overrides EVERY case's default graders for
// this batch only, so re-scoring a dataset differently never edits the dataset. Pure function; applied at submit
// AND at every re-materialization point (resume / retry-failed / Temporal planBatch) from the persisted orchestration.
export function applyGradingPlan(cases: EvalCase[], plan?: GraderSpec[]): EvalCase[] {
  if (!plan || plan.length === 0) return cases;
  return cases.map((c) => ({ ...c, graders: plan }));
}

export interface RunScorecardInput {
  tenant: string;
  // submitter (principal.subject) — the owner used to resolve a private-repo case's personally-owned connection ("clone via my connection").
  // Consequently a private-repo dataset is effectively single-owner (a case's connectionId only resolves when that owner submits).
  submittedBy?: string;
  dataset: { id: string; version: string };
  // pins = submit-time ephemeral pin overrides (slot→image, registry unchanged) — a CI PR fire swaps one service image for evaluation.
  // Recorded in origin.pinOverrides (reproducibility evidence). Durable changes go through POST /harnesses/:id/pins (a new instance version).
  harness: { id: string; version: string; pins?: Record<string, string> };
  origin?: ScorecardOrigin; // trigger origin (provenance) — the route/schedule stamps source
  judges?: Array<{ id: string; version: string }>; // selected Agent Judges — applied to the trace
  // Run-time grading plan — replaces every case's default graders for THIS batch (the dataset stays pure data).
  // Persisted in orchestration so resume/retry re-apply it. Absent = each case's own graders.
  graders?: GraderSpec[];
  runtime?: string; // tenant Runtime id to run on (placement.target). Absent = default backend.
  judge?: JudgeRunConfig; // inline judge-grader scoring-model override (defaults to the workspace default if unset)
  // Number of cases to dispatch concurrently within one batch (runSuite parallelism). Defaults to the service default if unset.
  // On self-hosted runtimes this many jobs park in the lease queue, and the runner must lease that many concurrently for real case-level parallelism.
  concurrency?: number;
  // Partial run — run only a subset of the full dataset (cost/smoke). Applied in order: ids (explicit selection) → tags (any-match) → limit (first N).
  // The result record is stamped with subset{total,selected,…} to mark that it is "not the whole thing".
  cases?: { ids?: string[]; tags?: string[]; limit?: number };
  // Transient dispatch retries per case (a THROWING dispatch only — a failing eval result is never retried).
  // Default 1. docs/architecture/batch-resilience.md
  retries?: number;
  // Run each case this many times for pass@k / flakiness (>=1). Absent = 1 (single run). Each case fans out into N
  // dispatches; the detail carries a derived trialSummary (pass@k / flake rate). docs/architecture/trial-based-verdict.md
  trials?: number;
  // Per-batch trace-sink override — the name of a configured workspace sink, or "none" to suppress export for
  // this batch. Absent = the harness's own selection (traceSinkByHarness). docs/architecture/trace-sink.md
  traceSink?: string;
  // In-batch OOM auto-boost (opt-in — every boost re-runs the case): an OOM_KILLED case re-dispatches inside
  // the batch with doubled job-only memory up to the cap, instead of waiting for a retry-failed round-trip.
  oomAutoBoost?: boolean;
}

export interface ScorecardServiceDeps {
  dispatcher: Dispatcher; // dispatch a case as a job (same path as a single run)
  store: ScorecardStore;
  // Grader factory (@everdict/graders) injected into executeCase/collectDeferredTrace collection-mode scoring — the
  // application layer never imports the grader impls, so apps/api supplies makeGraders here (re-architecture P2 S3).
  // Optional: a mock dispatcher (unit tests) never reaches the collection path; main.ts always supplies it.
  makeGraders?: ExecuteCaseDeps["makeGraders"];
  // Trace-only grader factory (@everdict/graders steps/cost/latency) for the ingest path — re-derive the same
  // observation metrics a live run produces, so an ingested scorecard aligns on diff. The grader impls live in
  // @everdict/graders, which the application layer never imports, so apps/api supplies them here (re-architecture
  // P2 S4). Absent = the ingest keeps only the uploaded scores (no derived trace metrics).
  defaultTraceGraders?: () => Grader[];
  datasets: DatasetRegistry; // dataset resolution (owner/_shared fallback) + case loading
  harnesses?: HarnessInstanceRegistry; // instance resolution (template+pins→resolved HarnessSpec). Built-ins fall back.
  judges?: JudgeRegistry; // judge resolution (owner/_shared fallback)
  judgeRunner?: JudgeRunner; // trace-based judge execution (model call / skip)
  // Workspace default judge model (for inline judge-grader scoring). A per-request override (RunScorecardInput.judge) takes precedence.
  judgeFor?: (tenant: string) => JudgeRunConfig | undefined | Promise<JudgeRunConfig | undefined>;
  budget?: BudgetTracker; // admit/settle per case
  // Meter-only usage accounting for billing (never blocks) — records each case's harness LLM cost, attributed to the
  // billing tenant. The billable surface is orchestration + verdict, not resold compute. docs/architecture/one-call-sdk.md
  usage?: UsageMeter;
  // Batch-on-Temporal driver (docs/architecture/temporal-batch-orchestration.md). When set, submit starts a durable
  // workflow that drives the batch through the internal routes instead of the in-process track loop.
  temporalBatches?: {
    workflowIdFor(scorecardId: string): string;
    start(scorecardId: string): Promise<void>;
    cancel?(scorecardId: string): Promise<void>; // supersede → cooperative workflow cancellation (best-effort)
  };
  // Registered runtime ids for this tenant — powers runtime:"auto" (expand to every registered runtime and shard).
  runtimesFor?: (tenant: string) => Promise<string[]>;
  // Per-runtime circuit breaker shared across batches — remembers a runtime outage so sharded batches spill
  // straight to a healthy runtime instead of re-discovering the failure per case. Defaults to an internal instance.
  breaker?: CircuitBreaker;
  // Boot-recovery adoption: harvest an already-dispatched case's result from the runtime's still-alive job
  // instead of re-dispatching (double compute). runtime = the child's recorded runtime (may be a comma list).
  adoptCase?: (tenant: string, runtime: string | undefined, caseId: string) => Promise<CaseResult | undefined>;
  // Supersede force-kill: stop a reclaimed batch's live orchestrator jobs (best-effort; cooperative abort already
  // stops the un-fired remainder — this reclaims the compute of the already-fired ones).
  killCase?: (tenant: string, runtime: string | undefined, caseId: string) => Promise<void>;
  // Per-batch trace-sink override validation — does a workspace sink with this name exist? (submit 400s otherwise).
  sinkExists?: (tenant: string, name: string) => Promise<boolean>;
  // Cancel still-QUEUED scheduler entries matching the predicate (supersede reclaim + speculation-loser reclaim).
  cancelQueued?: (predicate: (job: AgentJob) => boolean) => number;
  // Cancel matching self-hosted lease jobs (user stop / supersede) — rejects the parked/leased dispatch and tells the
  // runner (via its heartbeat) to abort the in-flight run, freeing the runtime mid-case. killCase covers managed
  // Nomad/K8s backends; self:* lanes are lease queues, so this is their force-kill path (RunnerHub.requestCancel).
  cancelLeased?: (predicate: (job: AgentJob) => boolean) => number | Promise<number>;
  // Orchestration-event observability hook (metrics) — fired on spillover / speculation / OOM escalation.
  // One generic seam so the service stays metrics-vocabulary-free; main.ts maps events to counters.
  onOrchestrationEvent?: (
    event:
      | { kind: "spillover"; from: string; to: string; code: string }
      | { kind: "speculation_fired"; from: string; to: string }
      | { kind: "speculation_settled"; winnerSpeculated: boolean }
      | { kind: "oom_escalated"; memoryMb: number }
      | { kind: "concurrency_adapted"; effective: number; previous: number; base: number },
  ) => void;
  // Adaptive batch concurrency (pressure signals) — scheduler queue depth + the threshold above which the
  // effective batch width halves. Absent queueDepth = breaker-only adaptation. docs/architecture/batch-resilience.md
  queueDepth?: () => number;
  queuePressure?: number; // queued entries above this = pressure (default 64)
  buildTraceSource?: (cfg: TraceSourceConfig) => TraceSource; // trace source factory for pull-ingest (@everdict/trace)
  // Resolve a REGISTERED workspace trace source by name → a usable TraceSourceConfig (auth resolved). Powers pull-ingest
  // "by name" (register once in the pool, then pull by name) — bound to TraceSourceService.resolveByName. Unknown name → 400.
  resolveTraceSourceByName?: (tenant: string, name: string) => Promise<TraceSourceConfig>;
  // Per-harness span-attribute mapping overlay (the conversion layer authored in the judge wizard, WorkspaceSettings
  // .spanAttrMappingByHarness) — applied to the pull-eval trace source so production traces normalize the way the
  // harness/judge expect. Absent = no overlay (span→TraceEvent uses the source config / OTel GenAI defaults).
  spanMappingFor?: (tenant: string, harnessId: string) => Promise<SpanAttrMapping | undefined>;
  secretsFor?: (tenant: string) => Promise<Record<string, string>>; // tenant SecretStore values (inject judge-model keys)
  // For resolving {secretRef} in harness env — two tiers: shared + submitter (owner) personal secrets. Injected by scope.
  scopedSecretsFor?: (tenant: string, subject?: string) => Promise<HarnessSecretMaps>;
  // Resolve a token for seeding a private repo — case env.source.connectionId → external-account connection token. Same as a single run (RunService.repoTokenFor).
  // The connection is personally owned, so resolve by owner (=submitter subject). Applied to every case in the dataset → private-repo dataset batch eval. The token is transient, only on the job (repoToken).
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
  // Workspace-owned GitHub App token (preferred) — if the case git URL owner matches the workspace installation, issue via that App (same as a single run).
  installationTokenFor?: (workspace: string, gitUrl: string) => Promise<string | undefined>;
  // Workspace image-registry pull credentials — if the job image belongs to that registry, attach via job.registryAuth (executeCase, same as a single run).
  registryAuthsFor?: (workspace: string) => Promise<RegistryAuth[]>;
  // Completion callback (succeeded/failed) — completion notification (Mattermost etc.). A failure here is independent of the scorecard result (the service swallows it).
  onComplete?: (tenant: string, record: ScorecardRecord) => Promise<void>;
  // Trace-sink export (when configured) — send scored results (trace+scores) to the workspace observability platform (TraceSinkService).
  // The returned outcome is recorded in record.export; a failure is isolated from the scorecard result (surfaced via outcome.status only). docs/architecture/trace-sink.md
  // attach: the pull-ingest (source.kind, caseId→external runId) — if source=sink platform, attach scores to the existing trace instead of duplicating.
  exportResults?: (
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string; sinkOverride?: string },
    results: CaseResult[],
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ) => Promise<ScorecardExport | undefined>;
  // Case-streaming sink export (D5) — build a stream so a live batch pushes each case the moment it completes (after judging).
  // If unset, a live batch falls back to exportResults (batched, after the run) (no regression). ingest always uses exportResults (batched).
  exportStreamFor?: (
    tenant: string,
    ctx: { scorecardId: string; dataset: string; harness: string; sinkOverride?: string },
  ) => Promise<CaseExportStream | undefined>;
  artifacts?: ArtifactStore; // when set, offload os-use screenshots to object storage (record keeps only the URL)
  // When set, fan out a child run (RunRecord) per case so each case becomes an addressable run (trace/usage/provenance).
  // When unset, keep the current behavior: an embedded scorecard only, no child runs (shares the same RunStore as a single run). Children are hidden from the activity list by default.
  runStore?: RunStore;
  concurrency?: number;
  // Policy gate: if true, a batch without a runtime is rejected 400 at submit (no local fallback). The API (main.ts) always sets true.
  // Unset (tests: inject a mock dispatcher directly) = no gate. Not an env toggle — a deployment's fixed policy.
  requireRuntime?: boolean;
  // Submit-time placement preflight — reject a batch (400) whose chosen runtime(s) can't run the harness (e.g. a
  // Windows-service topology on a Linux-only cluster), before any case is dispatched. Called per runtime in the
  // comma-list (sharding). Wired by apps/api (harness + runtime registries); absent in unit tests. Throws BadRequestError.
  // self:* targets are skipped (the runner lease gate handles those); RuntimeDispatcher is the per-case backstop.
  preflightPlacement?: (input: {
    tenant: string;
    target: string;
    harness: { id: string; version: string };
  }) => Promise<void>;
  newId?: () => string;
  now?: () => string;
}

// Offload os-use screenshots (inline base64) to object storage → each result snapshot.screenshotRef=URL, screenshot cleared (slim
// record). best-effort: on failure keep the base64 (no effect on the scorecard itself). Called after applyJudges (once registry judges have used the image).
export async function offloadResults(deps: ScorecardServiceDeps, id: string, results: CaseResult[]): Promise<void> {
  if (!deps.artifacts) return;
  for (const r of results) {
    try {
      r.snapshot = await offloadSnapshot(r.snapshot, deps.artifacts, `scorecards/${id}/${r.caseId}.png`);
    } catch {}
  }
}
