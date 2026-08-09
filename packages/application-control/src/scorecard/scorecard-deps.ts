import type {
  CaseJob,
  CaseResult,
  Grader,
  JudgeRunConfig,
  ModelBinding,
  RegistryAuth,
  ScorecardExport,
  ScorecardRecord,
  SpanAttrMapping,
  TraceSource,
  TraceSourceConfig,
} from "@everdict/contracts";
import type {
  BudgetTracker,
  CircuitBreaker,
  HarnessSecretMaps,
  ScoringStageParity,
  UsageMeter,
} from "@everdict/domain";
import type { ExecuteCaseDeps } from "../execution/execute-case.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { Dispatcher } from "../ports/dispatcher.js";
import type { EnvelopeStore } from "../ports/envelope-store.js";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { JudgeRunner } from "../ports/judge-runner.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RecordingStore } from "../ports/recording-store.js";
import type { RubricRegistry } from "../ports/rubric-registry.js";
import type { RunStore } from "../ports/run-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { ScoringStageStore } from "../ports/scoring-stage-store.js";
import type { TrajectoryStore } from "../ports/trajectory-store.js";
import type { CaseExportStream } from "../trace-sink/trace-sink-service.js";
import type { OrchestrationEvent } from "./scorecard-observability.js";

// The scorecard composition surface (review §21/§22): the union bag main.ts wires once, plus the
// per-collaborator Pick views each service constructor narrows to.

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
  // Rubric resolution for the judge-closure seal (H8): a judge whose rubric is a `{id, version?}` REF is
  // judged under whatever that ref resolves to at RUN time — the seal pins the latest-resolution at
  // submit/re-score so identity can compare it. Absent = latest rubric refs seal "unresolved" (honest).
  rubrics?: RubricRegistry;
  judgeRunner?: JudgeRunner; // trace-based judge execution (model call / skip)
  // Workspace default judge model (for inline judge-grader scoring). A per-request override (RunScorecardInput.judge) takes precedence.
  judgeFor?: (tenant: string) => JudgeRunConfig | undefined | Promise<JudgeRunConfig | undefined>;
  // Resolve a ModelBinding to its CONCRETE identity for the manifest seal ("ref@version" after latest-
  // resolution; a raw string binding is already concrete and never reaches this). The manifest must seal the
  // resolved dependency CLOSURE, not the top documents: a judge spec pinning `{ref: "judge-default"}` is a
  // byte-identical document over a moving target, and two batches sealed under it can be judged by different
  // models while the spec digests read held. Absent = the closure stays unsealed (identity reads it honestly).
  resolveModelBinding?: (tenant: string, binding: Exclude<ModelBinding, string>) => Promise<string | undefined>;
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
  // Score-on-Temporal (P2 / orchestration.md T-c): a detached scoring pass runs as a durable score:<groupId>
  // workflow, so re-scoring a large group survives a control-plane restart with zero duplicate judging
  // (planScore is idempotent — unfinished-only). start throws ConflictError when a pass is already running
  // (deterministic workflowId = the dedup); any other start failure degrades to the in-process pass.
  // The scoring STAGE (docs/architecture/scoring-plane-revisions.md, expand step). When wired, a pass
  // dual-writes its judgments here as well as onto the live plane — the stage is written and never read, so
  // this deploy can be rolled back without losing anything, and the contract step later makes the finalize
  // promote from it. Absent = the pre-stage behavior, unchanged.
  scoringStage?: ScoringStageStore;
  // Where a settled pass reports how its STAGE compared to the plane it wrote (arch-review 10 P1). The
  // contract step moves the source of truth from the carriers to the stage, and the evidence for that move
  // is having watched the two agree on real traffic — a week of dual-writing that nobody compared is not
  // evidence. Absent = no reporting (unit paths); the comparison is skipped, never faked.
  scoringStageParity?: (parity: ScoringStageParity) => void;
  temporalScores?: {
    // PASS-SCOPED (arch-review 10 P0). A group-scoped id made Temporal a SECOND authority on "who owns this
    // group's score plane", competing with the database's pass marker — and the two disagreed exactly when it
    // mattered: a takeover pass B legitimately owned the marker, then failed to start because A's workflow
    // still held the group's id, leaving B holding a plane it could not drive. Ownership is the marker's job
    // and it does it with a CAS; the workflow id's only remaining job is deduplicating retries of ONE pass's
    // own start, which a pass-scoped id does exactly.
    workflowIdFor(groupId: string, passId: string): string;
    start(input: {
      groupId: string;
      judges: Array<{ id: string; version: string }>;
      submittedBy?: string;
      // The pass the CLAIM minted — REQUIRED (arch-review 9 P0). It was optional, and an adapter whose
      // inline parameter type simply omitted it still satisfied this port: structural typing dropped the
      // field silently between the claim and the workflow, so every production activity arrived with no
      // identity and ADOPTED whatever marker was live. Required makes that omission a compile error, which
      // is the only check that watches every adapter on the way to Temporal.
      passId: string;
    }): Promise<void>;
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
  cancelQueued?: (predicate: (job: CaseJob) => boolean) => number;
  // Cancel matching self-hosted lease jobs (user stop / supersede) — rejects the parked/leased dispatch and tells the
  // runner (via its heartbeat) to abort the in-flight run, freeing the runtime mid-case. killCase covers managed
  // Nomad/K8s backends; self:* lanes are lease queues, so this is their force-kill path (RunnerHub.requestCancel).
  cancelLeased?: (predicate: (job: CaseJob) => boolean) => number | Promise<number>;
  // Orchestration-event observability hook (metrics) — fired on spillover / speculation / OOM escalation /
  // batch settle. One generic seam so the service stays metrics-vocabulary-free; main.ts maps events to counters.
  onOrchestrationEvent?: (event: OrchestrationEvent) => void;
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
  registryAuthsFor?: (workspace: string, images: string[]) => Promise<RegistryAuth[]>;
  // Completion callback (succeeded/failed) — completion notification (Mattermost etc.). A failure here is independent of the scorecard result (the service swallows it).
  onComplete?: (tenant: string, record: ScorecardRecord) => Promise<void>;
  // Platform-event seam (agent-automation A1). Since E0, the batch lifecycle facts (scorecard.submitted/
  // completed/failed/cancelled) are computed by the ScorecardBatch transitions and persisted through the
  // store's same-tx outbox — this emitter carries only their pushPersisted latency nudge plus the one
  // remaining direct emit, scorecard.case.completed (streaming, both drivers). emit never throws (best-effort).
  events?: PlatformEventEmitter;
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
  // Envelope spend ledger (§5.2, P4) — the submit gate reads headroom, the per-case settle meters cost.
  envelopes?: EnvelopeStore;
  admissionMaxInFlight?: number; // O7 in-flight cap override (EVERDICT_ENVELOPE_MAX_INFLIGHT)
  // The OWNED trajectory store (P5 rung 1) — every settled case's trace seals here too (dual-write).
  trajectories?: TrajectoryStore;
  // Durable replay recording (optional) — at child write-back, seal the frames/logs teed under the child's runId and attach the ref.
  recordingStore?: RecordingStore;
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

// ── Per-collaborator dependency views (review §21) ──
// The bag above is the UNION a composition root wires once; each collaborator names the slice it actually
// collaborates with, so the type answers "what does ingest really touch" without reading 400 lines of
// implementation. Pick<> only — no new abstraction, no behavioral change: the facade still passes the one
// wired object, and structural typing narrows it at each constructor.

// The batch orchestrator — dispatch, budgets, export, recovery: the execution heart is the WIDE collaborator,
// but wide is not "everything it might one day want". The Omit<…,"temporalScores"> this replaces meant every
// key later added to the bag flowed into the batch surface automatically — a saga being broad and a saga
// seeing every capability are different claims. Own orchestration keys first, then the slices it forwards
// wholesale to its helpers (executeCase / offloadResults / offloadAnalysis / collectDeferredTrace), which
// narrow structurally from the same bag.
export type ScorecardBatchDeps = Pick<
  ScorecardServiceDeps,
  // orchestration: dispatch, recovery, queue, budgets, settlement
  | "dispatcher"
  | "store"
  | "runStore"
  | "scoringStage"
  | "scoringStageParity"
  | "datasets"
  | "harnesses"
  | "budget"
  | "usage"
  | "envelopes"
  | "temporalBatches"
  | "adoptCase"
  | "cancelQueued"
  | "queueDepth"
  | "queuePressure"
  | "onOrchestrationEvent"
  | "onComplete"
  | "events"
  // evidence + export
  | "trajectories"
  | "recordingStore"
  | "artifacts"
  | "exportResults"
  | "exportStreamFor"
  // forwarded to executeCase / collectDeferredTrace (the in-flight case pipeline)
  | "scopedSecretsFor"
  | "secretsFor"
  | "makeGraders"
  | "buildTraceSource"
  | "installationTokenFor"
  | "repoTokenFor"
  | "registryAuthsFor"
>;

// External-trace ingest: no dispatcher, no queue, no recovery — it scores traces someone else produced.
export type ScorecardIngestDeps = Pick<
  ScorecardServiceDeps,
  | "store"
  | "datasets"
  | "defaultTraceGraders"
  | "buildTraceSource"
  | "resolveTraceSourceByName"
  | "secretsFor"
  | "spanMappingFor"
  | "exportResults"
  | "trajectories"
  | "artifacts"
  | "newId"
  | "now"
>;

// Read-side analytics: the store and the offloaded-analysis artifacts. Nothing here can dispatch or kill.
export type ScorecardAnalyticsDeps = Pick<ScorecardServiceDeps, "store" | "artifacts">;

// Detached scoring (phase 2 / re-score): the stores it rewrites plus the Temporal score bridge. `judges` +
// `resolveModelBinding` let the rescore aggregate re-seal the selected judges' closure (the same sealer as
// submit), and `artifacts` lets it re-freeze the analysis bundle from the pass's own plane — a re-score
// rewrites scoring identity, so it must be able to rewrite everything that DESCRIBES that identity.
export type ScorecardScoringDeps = Pick<
  ScorecardServiceDeps,
  | "store"
  | "runStore"
  | "scoringStage"
  | "scoringStageParity"
  | "datasets"
  | "events"
  | "temporalScores"
  | "newId"
  | "now"
  | "judges"
  | "resolveModelBinding"
  | "rubrics"
  | "harnesses"
  | "artifacts"
>;
