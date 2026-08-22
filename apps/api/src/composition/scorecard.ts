import type {
  ConstitutionApprovalStore,
  EnvelopeStore,
  GithubAppService,
  PublicationOperationStore,
  ScoringStageStore,
  TrajectoryStore,
} from "@everdict/application-control";
import type { ImageRegistryService } from "@everdict/application-control";
import type { NotificationService, PlatformEventService } from "@everdict/application-control";
import type { Metrics } from "@everdict/application-control";
import type {
  CancellationStore,
  CaseReceiptStore,
  ExecutionAttemptStore,
  RecordingStore,
} from "@everdict/application-control";
import type { RunnerHubLike } from "@everdict/application-control";
import { ScorecardService, TraceSourceService } from "@everdict/application-control";
import type { TraceSinkService } from "@everdict/application-control";
import type { Dispatcher as CoreDispatcher, Scheduler } from "@everdict/backends";
import type { AdoptionDecision, CaseResult, KillOutcome, RegistryAuth, RuntimeWorkRef } from "@everdict/contracts";
import type { RunStore, ScorecardStore, WorkspaceSettingsStore } from "@everdict/db";
import { type CircuitBreaker, type UsageMeter, stagePromotionSafe } from "@everdict/domain";
import { costGrader, latencyGrader, makeGraders, stepsGrader } from "@everdict/graders";
import type {
  DatasetRegistry,
  HarnessInstanceRegistry,
  JudgeRegistry,
  ModelRegistry,
  RubricRegistry,
  RuntimeRegistry,
} from "@everdict/registry";
import type { S3ArtifactStore } from "@everdict/storage";
import { buildTraceSource } from "@everdict/trace";
import type { PersistentBudget } from "../common/budget-tracker.js";
import type { JudgeRunner } from "../core/execution/judge-runner.js";
import type { PlacementPreflight } from "../core/execution/placement-preflight.js";
import { TemporalBatchDriver } from "../core/scorecard/temporal-batch-driver.js";
import type { RuntimeSecretsFn, ScopedSecretsFn } from "./types.js";

// Per-runtime kill of an already-dispatched case (supersede / speculation loser) — from buildRuntimeAccess.
export interface ScorecardRuntimeAccess {
  adoptWorkFn: (tenant: string, runtimeList: string | undefined, work: RuntimeWorkRef) => Promise<AdoptionDecision>;
  killUnhandled: (tenant: string, runtimeList: string | undefined) => Promise<KillOutcome>;
  // The exact-handle stop (arch-review 52, Wave 2) — `killUnhandled` answers for rows that recorded none.
  killWork: (tenant: string, runtimeList: string | undefined, work: RuntimeWorkRef) => Promise<KillOutcome>;
}

// The manifest's model-binding resolution, as ONE function (arch-review 15 P1-5). A judge or harness spec
// pinning `{ref: "main-model"}` with no version is a byte-identical document over a moving target; resolving
// it to `ref@version` is what makes "same spec digest" mean "same model". The product's series-contract
// resolver seals with the very same helper, so the release gate and the batch manifest cannot answer the
// identity question two different ways — which is exactly what they were doing.
export function modelBindingResolver(
  modelRegistry: ModelRegistry,
): (tenant: string, binding: { ref: string; version?: string }) => Promise<string | undefined> {
  return async (tenant, binding) => {
    const spec = await modelRegistry.get(tenant, binding.ref, binding.version ?? "latest");
    return `${binding.ref}@${spec.version}`;
  };
}

// Batch eval: run a dataset (bundle of cases) against a harness@version, aggregate into a scorecard + apply the selected judges to each trace.
export function buildScorecard(deps: {
  scorecardStore: ScorecardStore;
  runStore: RunStore;
  // The scoring stage (mig 0149) — a pass dual-writes its judgments here (expand step).
  scoringStageStore: ScoringStageStore;
  envelopes: EnvelopeStore; // envelope spend ledger (§5.2 P4)
  trajectories: TrajectoryStore; // the owned trajectory store (P5 rung 1)
  recordingStore?: RecordingStore;
  caseReceipts?: CaseReceiptStore; // where a case's canonical outcome is decided (mig 0175)
  attempts?: ExecutionAttemptStore; // every physical execution behind those receipts (mig 0182)
  cancellations?: CancellationStore; // the cancel teardown's durable owner (mig 0184)
  publicationOperations?: PublicationOperationStore; // the publication's durable owner (mig 0188)
  publisherId?: string; // this process, for the publication claim's lease
  // Told when a case opens a new attempt, so this process's recorder stamps the generation the store fences
  // on (mig 0173). Without it a re-driven case's producers keep sending the previous number and every one of
  // their appends is refused — the fence turning into a silent recording outage.
  // The receipts constitutional declarations leave (mig 0165) — submit refuses an unapproved one.
  constitutionApprovals?: ConstitutionApprovalStore;
  meteredDispatcher: CoreDispatcher;
  scheduler: Scheduler;
  // Self-hosted lease hub — cancel/supersede reclaims a batch's in-flight lease jobs through it (requestCancel).
  runnerHub: RunnerHubLike;
  breaker: CircuitBreaker;
  metrics: Metrics;
  settingsStore: WorkspaceSettingsStore;
  datasetRegistry: DatasetRegistry;
  harnessInstanceRegistry: HarnessInstanceRegistry;
  judgeRegistry: JudgeRegistry;
  rubricRegistry: RubricRegistry;
  modelRegistry: ModelRegistry;
  runtimeRegistry: RuntimeRegistry;
  judgeRunner: JudgeRunner;
  budget: PersistentBudget;
  usageMeter: UsageMeter;
  artifacts: S3ArtifactStore | undefined;
  runtimeSecretsFor: RuntimeSecretsFn;
  scopedSecretsFor: ScopedSecretsFn;
  githubAppService: GithubAppService;
  // Image pull credentials for a job's images (managed grants + BYO) — built once in buildDispatch.
  registryAuthsFor: (workspace: string, images: string[]) => Promise<RegistryAuth[]>;
  notificationService: NotificationService;
  platformEventService: PlatformEventService;
  traceSinkService: TraceSinkService;
  preflightPlacement: PlacementPreflight;
  killUnhandled: ScorecardRuntimeAccess["killUnhandled"];
  killWork: ScorecardRuntimeAccess["killWork"];
  adoptWorkFn: ScorecardRuntimeAccess["adoptWorkFn"];
}): ScorecardService {
  const {
    scorecardStore,
    runStore,
    scoringStageStore,
    recordingStore,
    caseReceipts,
    attempts,
    cancellations,
    publicationOperations,
    publisherId,
    meteredDispatcher,
    scheduler,
    runnerHub,
    breaker,
    metrics,
    settingsStore,
    datasetRegistry,
    harnessInstanceRegistry,
    judgeRegistry,
    rubricRegistry,
    modelRegistry,
    runtimeRegistry,
    judgeRunner,
    budget,
    usageMeter,
    artifacts,
    runtimeSecretsFor,
    scopedSecretsFor,
    githubAppService,
    registryAuthsFor,
    notificationService,
    platformEventService,
    traceSinkService,
    preflightPlacement,
    killUnhandled,
    killWork,
    adoptWorkFn,
  } = deps;

  // Batch-on-Temporal (opt-in): the durable workflow drives batches through the internal routes.
  // Batch-on-Temporal is DEFAULT-ON once an address is configured (a deployment that stood Temporal up wants the
  // durability); EVERDICT_TEMPORAL_BATCHES=0 opts back out to the in-process loop. Start failure still degrades
  // per submit, so a flaky Temporal never blocks evaluation.
  const temporalBatchAddress =
    process.env.EVERDICT_TEMPORAL_ADDRESS && process.env.EVERDICT_TEMPORAL_BATCHES !== "0"
      ? process.env.EVERDICT_TEMPORAL_ADDRESS
      : undefined;
  // One driver instance serves both durable families: the batch workflow (everdict-batch-<id>) and the
  // detached scoring pass (everdict-score-<id>, orchestration.md T-c).
  const temporalDriver = temporalBatchAddress
    ? new TemporalBatchDriver({
        address: temporalBatchAddress,
        // History-budget dial: settled cases per workflow execution before continue-as-new (default 500 in the workflow).
        ...(process.env.EVERDICT_TEMPORAL_BATCH_CONTINUE_EVERY
          ? { continueEvery: Number(process.env.EVERDICT_TEMPORAL_BATCH_CONTINUE_EVERY) }
          : {}),
        // Adaptive continue-as-new floor (event count) — the server's continueAsNewSuggested is primary.
        ...(process.env.EVERDICT_TEMPORAL_BATCH_ROTATE_HISTORY
          ? { rotateAtHistoryLength: Number(process.env.EVERDICT_TEMPORAL_BATCH_ROTATE_HISTORY) }
          : {}),
      })
    : undefined;

  // Resolve a REGISTERED workspace trace source by name for pull-ingest "by name" (same pool the dispatch path reads).
  const traceSourcesForIngest = new TraceSourceService(settingsStore, { secretsFor: runtimeSecretsFor });

  return new ScorecardService({
    envelopes: deps.envelopes, // §5.2 — submit-gate headroom + per-case draw-down
    ...(envelopeMaxInFlight() !== undefined ? { admissionMaxInFlight: envelopeMaxInFlight() } : {}),
    trajectories: deps.trajectories, // P5 dual-write — child-case traces seal in the owned store
    dispatcher: meteredDispatcher,
    store: scorecardStore,
    // Grader factory (@everdict/graders) for executeCase/collectDeferredTrace collection-mode scoring (re-architecture P2 S3).
    makeGraders,
    // Trace-only graders (@everdict/graders) for the ingest path — re-derive steps/cost/latency so an ingested
    // scorecard aligns on diff with a live run. The application layer never imports the impls (re-architecture P2 S4).
    defaultTraceGraders: () => [stepsGrader, costGrader, latencyGrader],
    breaker, // shared with the queue view — spillover writes, observability reads
    onOrchestrationEvent: (event) => {
      if (event.kind === "spillover")
        metrics.counter("everdict_spillover_total", "Runtime spillovers.", { from: event.from, to: event.to });
      else if (event.kind === "speculation_fired")
        metrics.counter("everdict_speculation_fired_total", "Tail-speculation duplicates fired.", {});
      else if (event.kind === "speculation_settled")
        metrics.counter("everdict_speculation_won_total", "Speculated cases settled by a duplicate win.", {
          winner: event.winnerSpeculated ? "duplicate" : "primary",
        });
      else if (event.kind === "oom_escalated")
        metrics.counter("everdict_oom_escalated_total", "OOM auto-escalations on retry.", {});
      else if (event.kind === "concurrency_adapted")
        metrics.counter("everdict_concurrency_adapted_total", "Adaptive batch-width transitions.", {
          direction: event.effective < event.previous ? "shrink" : "restore",
        });
      else if (event.kind === "batch_settled") {
        // Catalog M0 — the contract's closed vocabulary as time series. Labels are closed sets only
        // (outcome states, unmeasured reasons); graderId/caseId never label a series (unbounded cardinality).
        const o = event.outcomes;
        const outcomeCounts = {
          completed: o.verdicted,
          unmeasured: o.unmeasured,
          infra_failed: o.infraFailed,
          cancelled: o.cancelled,
        };
        for (const [outcome, count] of Object.entries(outcomeCounts)) {
          if (count > 0)
            metrics.counter(
              "everdict_case_outcome_total",
              "Case fates at batch settle (CaseOutcome vocabulary).",
              { outcome },
              count,
            );
        }
        for (const [reason, count] of Object.entries(event.unmeasuredReasons)) {
          metrics.counter(
            "everdict_unmeasured_total",
            "Unmeasured scores by reason at batch settle.",
            { reason },
            count,
          );
        }
        metrics.observe(
          "everdict_verdict_latency_seconds",
          "Batch submit → terminal verdict latency.",
          {},
          event.latencySec,
        );
      }
    },
    // Adaptive batch concurrency — pressure = the shared scheduler's queue depth (EVERDICT_QUEUE_PRESSURE dial).
    queueDepth: () => scheduler.stats().queued,
    ...(process.env.EVERDICT_QUEUE_PRESSURE ? { queuePressure: Number(process.env.EVERDICT_QUEUE_PRESSURE) } : {}),
    // Per-batch sink override validation (submit 400s on an unknown sink name; "none" is always allowed).
    sinkExists: async (tenant, name) =>
      ((await settingsStore.get(tenant))?.traceSinks ?? []).some((e) => e.name === name),
    // Queued-entry reclaim (supersede / speculation loser) — in-flight jobs stay Backend.kill's concern.
    cancelQueued: (predicate) => scheduler.cancelQueued(predicate),
    // Self-hosted lease reclaim (supersede / user cancel) — rejects the parked/leased dispatch and tells the runner
    // to abort the in-flight run (freeing the runtime mid-case); the managed force-kill is killWork below.
    cancelLeased: (predicate) => runnerHub.requestCancel(predicate),
    adoptWork: adoptWorkFn,
    // …and where `withVerifierPass` staged the agent's half, so a batch that crashed between a case's two
    // halves FINISHES the verdict its verifier already produced rather than re-driving the whole case. The
    // standalone recovery has had this since arch-review 61; this owner did not, which is how one protocol
    // ended up with two behaviours (arch-review 62 P1).
    ...(artifacts ? { agentHalves: artifacts } : {}),
    killUnhandled,
    killWork,
    ...(temporalDriver
      ? {
          temporalBatches: temporalDriver,
          temporalScores: {
            // Pass-scoped (arch-review 10 P0) — the database's marker is the sole authority on who owns a
            // group's plane; this id only deduplicates one pass's own start retries.
            workflowIdFor: (groupId: string, passId: string) => temporalDriver.scoreWorkflowIdFor(groupId, passId),
            // `passId` MUST be listed here, and REQUIRED. An inline parameter type that omits (or optionals)
            // it still satisfies the port — parameter bivariance ignores the difference — so the field was
            // silently dropped between the claim and the workflow, and an activity with no passId ADOPTS
            // whatever marker is live, which is precisely the fence being bypassed. Written out so a future
            // edit that drops it fails at the forwarding call instead of at runtime.
            start: (input: {
              groupId: string;
              judges: Array<{ id: string; version: string }>;
              submittedBy?: string;
              passId: string;
            }) => temporalDriver.startScore(input),
          },
        }
      : {}),
    // runtime:"auto" — expand to every registered runtime id for the tenant (sharding across all of them).
    runtimesFor: async (tenant) => (await runtimeRegistry.list(tenant)).map((r) => r.id),
    requireRuntime: true, // policy (default): a batch with no runtime is 400 at submit — the API does not register local
    preflightPlacement, // submit-time capability gate: reject a harness/runtime mismatch (per runtime in the shard list) at 400
    // Fan out a child run per case (sharing the same RunStore as a single run) — each case becomes an addressable run, hidden by default in the activity list.
    runStore,
    scoringStage: scoringStageStore,
    // The stage's read-side switch (arch-review 43 ①), OFF unless a deployment says otherwise. `=== "1"` and
    // nothing else: an unset, empty or misspelled value must land on the carriers, because the one thing a
    // migration flag may never do is turn itself on by accident.
    scoringStageAuthoritative: process.env.EVERDICT_SCORING_STAGE_AUTHORITATIVE === "1",
    // The stage/carrier PARITY signal (arch-review 10 P1) — the evidence the contract step needs before it
    // can move the source of truth onto the stage. `result` is the whole point of the label: a dashboard
    // showing only a total says dual-writing happened, which was never in doubt. A mismatch is also logged,
    // named by pass, because a rate alone cannot be investigated.
    scoringStageParity: (parity) => {
      const HELP = "Scoring-stage rows compared against the settled plane, by outcome.";
      const bump = (result: string, n: number) => {
        if (n > 0) metrics.counter("everdict_scoring_stage_parity_total", HELP, { result }, n);
      };
      // Attempt/outcome coverage first (arch-review 13 P1): a `mismatched = 0` dashboard means nothing
      // unless you also know how many comparisons actually ran.
      bump(parity.completed ? "report_completed" : "report_failed", 1);
      if (!parity.completed) {
        console.warn(
          `[scoring-stage] parity report FAILED for ${parity.scorecardId} pass ${parity.passId}: ${parity.failure ?? "unknown"} — this pass is unmeasured, not agreeing`,
        );
        return;
      }
      bump("matched", parity.matched);
      bump("mismatched", parity.mismatched.length);
      bump("orphaned", parity.orphaned.length);
      // The dimension that makes the metric able to say NO (arch-review 11): judged, and never staged. Without
      // it the series could only report on writes that happened, so a stage losing a fifth of its rows still
      // graphed as perfect parity — and the contract step reads this graph.
      bump("missing_from_stage", parity.missingFromStage.length);
      // The precondition itself, so an operator reads a verdict rather than reconstructing one from four
      // series. `stagePromotionSafe` is the same predicate the contract step must gate on.
      if (!stagePromotionSafe(parity)) {
        console.warn(
          `[scoring-stage] parity NOT promotion-safe on ${parity.scorecardId} pass ${parity.passId}: judged=${parity.expectedJudged} staged=${parity.staged} matched=${parity.matched} missing=[${parity.missingFromStage.join(", ")}] mismatched=[${parity.mismatched.join(", ")}] orphaned=[${parity.orphaned.join(", ")}]`,
        );
      }
    },
    ...(recordingStore ? { recordingStore } : {}),
    ...(caseReceipts ? { caseReceipts } : {}),
    ...(attempts ? { attempts } : {}),
    ...(cancellations ? { cancellations } : {}),
    ...(publicationOperations ? { publicationOperations } : {}),
    ...(publisherId !== undefined ? { publisherId } : {}),
    datasets: datasetRegistry,
    harnesses: harnessInstanceRegistry,
    judges: judgeRegistry,
    // Judge-closure seal (H8): a rubric REF resolves at run time, so the seal pins its latest-resolution.
    rubrics: rubricRegistry,
    // The manifest's dependency-closure seal: a judge's `{ref}` binding resolves to its concrete version at
    // submit, so "same spec digest, different actual model" stops reading as an identical judge.
    resolveModelBinding: modelBindingResolver(deps.modelRegistry),
    // …and the model DOCUMENT reader the recursive pin needs (arch-review 19 P0-4): a ref string cannot tell
    // a `_shared` model from a workspace-local one wearing its name, and only reading the document can.
    models: deps.modelRegistry,
    judgeRunner,
    budget,
    usage: usageMeter,
    ...(artifacts ? { artifacts } : {}),
    // Workspace default judge model (a per-request override wins): the batch eval's inline judge grader scores with this model.
    judgeFor: async (tenant) => (await settingsStore.get(tenant))?.judge,
    // The receipts constitutional declarations leave — submit REFUSES a dataset that declares ground_truth
    // without one (arch-review 23 P1), and `attest_dataset_constitution` is how an old one gets its receipt.
    ...(deps.constitutionApprovals ? { constitutionApprovals: deps.constitutionApprovals } : {}),
    // Pull ingest: pull traces from the tenant's OTel/MLflow and score them. Credentials come from the tenant SecretStore (authSecret name).
    buildTraceSource,
    // "Register once, pull by name" — a pull-ingest source given as { name } resolves against the workspace pool.
    resolveTraceSourceByName: (tenant, name) => traceSourcesForIngest.resolveByName(tenant, name),
    // Per-harness span-attribute mapping overlay (judge-wizard-authored) — applied to the pull-eval trace source so
    // production traces normalize the way this harness/judge expect (WorkspaceSettings.spanAttrMappingByHarness).
    spanMappingFor: async (tenant, harnessId) =>
      (await settingsStore.get(tenant))?.spanAttrMappingByHarness?.[harnessId],
    secretsFor: runtimeSecretsFor, // judge model key (shared secret)
    scopedSecretsFor, // resolve harness env {secretRef} (shared + submitter's personal)
    // Private-repo dataset (preferred): if the case git URL owner matches the workspace GitHub App installation, use that App token (same as a single run).
    installationTokenFor: (workspace, gitUrl) => githubAppService.tokenForRepo(workspace, gitUrl),
    // Image pull credentials — batch cases authorize exactly like a single run (one resolver, one behavior).
    registryAuthsFor,
    // Completion notification (Mattermost) — batch-eval completion posts to the channel just like a run.
    // Lifecycle facts (agent-automation A1) — scorecard.submitted / case.completed / cancelled.
    events: platformEventService,
    // Trace sink export — export judged detail results to the workspace observability platform (outcome recorded on record.export).
    exportResults: (tenant, ctx, results, attach) => traceSinkService.exportScorecard(tenant, ctx, results, attach),
    // A live batch streams the export the moment a case completes (after judging) (D5) — ingest keeps the batched exportResults above.
    exportStreamFor: (tenant, ctx) => traceSinkService.exportStream(tenant, ctx),
  });
}

// O7 in-flight cap override — one env knob for the gate's outstanding-runs backstop (default lives in the gate).
function envelopeMaxInFlight(): number | undefined {
  const raw = process.env.EVERDICT_ENVELOPE_MAX_INFLIGHT;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
