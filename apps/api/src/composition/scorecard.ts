import type { CircuitBreaker, Dispatcher as CoreDispatcher, Scheduler } from "@everdict/backends";
import type { UsageMeter } from "@everdict/billing";
import type { CaseResult } from "@everdict/core";
import type { RunStore, ScorecardStore, WorkspaceSettingsStore } from "@everdict/db";
import { costGrader, latencyGrader, makeGraders, stepsGrader } from "@everdict/graders";
import type { DatasetRegistry, HarnessInstanceRegistry, JudgeRegistry, RuntimeRegistry } from "@everdict/registry";
import type { S3ArtifactStore } from "@everdict/storage";
import { buildTraceSource } from "@everdict/trace";
import type { PersistentBudget } from "../common/budget-tracker.js";
import type { JudgeRunner } from "../core/execution/judge-runner.js";
import type { GithubAppService } from "../core/github-app/github-app-service.js";
import type { ImageRegistryService } from "../core/image-registry/image-registry-service.js";
import type { NotificationService } from "../core/notification/notification-service.js";
import type { Metrics } from "../core/ops/metrics.js";
import { ScorecardService } from "../core/scorecard/scorecard-service.js";
import { TemporalBatchDriver } from "../core/scorecard/temporal-batch-driver.js";
import type { TraceSinkService } from "../core/trace-sink/trace-sink-service.js";
import type { RuntimeSecretsFn, ScopedSecretsFn } from "./types.js";

// Per-runtime kill of an already-dispatched case (supersede / speculation loser) — from buildRuntimeAccess.
export interface ScorecardRuntimeAccess {
  adoptCaseFn: (tenant: string, runtimeList: string | undefined, caseId: string) => Promise<CaseResult | undefined>;
  killCase: (tenant: string, runtimeList: string | undefined, caseId: string) => Promise<void>;
}

// Batch eval: run a dataset (bundle of cases) against a harness@version, aggregate into a scorecard + apply the selected judges to each trace.
export function buildScorecard(deps: {
  scorecardStore: ScorecardStore;
  runStore: RunStore;
  meteredDispatcher: CoreDispatcher;
  scheduler: Scheduler;
  breaker: CircuitBreaker;
  metrics: Metrics;
  settingsStore: WorkspaceSettingsStore;
  datasetRegistry: DatasetRegistry;
  harnessInstanceRegistry: HarnessInstanceRegistry;
  judgeRegistry: JudgeRegistry;
  runtimeRegistry: RuntimeRegistry;
  judgeRunner: JudgeRunner;
  budget: PersistentBudget;
  usageMeter: UsageMeter;
  artifacts: S3ArtifactStore | undefined;
  runtimeSecretsFor: RuntimeSecretsFn;
  scopedSecretsFor: ScopedSecretsFn;
  githubAppService: GithubAppService;
  imageRegistryService: ImageRegistryService;
  notificationService: NotificationService;
  traceSinkService: TraceSinkService;
  killCase: ScorecardRuntimeAccess["killCase"];
  adoptCaseFn: ScorecardRuntimeAccess["adoptCaseFn"];
}): ScorecardService {
  const {
    scorecardStore,
    runStore,
    meteredDispatcher,
    scheduler,
    breaker,
    metrics,
    settingsStore,
    datasetRegistry,
    harnessInstanceRegistry,
    judgeRegistry,
    runtimeRegistry,
    judgeRunner,
    budget,
    usageMeter,
    artifacts,
    runtimeSecretsFor,
    scopedSecretsFor,
    githubAppService,
    imageRegistryService,
    notificationService,
    traceSinkService,
    killCase,
    adoptCaseFn,
  } = deps;

  // Batch-on-Temporal (opt-in): the durable workflow drives batches through the internal routes.
  // Batch-on-Temporal is DEFAULT-ON once an address is configured (a deployment that stood Temporal up wants the
  // durability); EVERDICT_TEMPORAL_BATCHES=0 opts back out to the in-process loop. Start failure still degrades
  // per submit, so a flaky Temporal never blocks evaluation.
  const temporalBatchAddress =
    process.env.EVERDICT_TEMPORAL_ADDRESS && process.env.EVERDICT_TEMPORAL_BATCHES !== "0"
      ? process.env.EVERDICT_TEMPORAL_ADDRESS
      : undefined;

  return new ScorecardService({
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
    },
    // Adaptive batch concurrency — pressure = the shared scheduler's queue depth (EVERDICT_QUEUE_PRESSURE dial).
    queueDepth: () => scheduler.stats().queued,
    ...(process.env.EVERDICT_QUEUE_PRESSURE ? { queuePressure: Number(process.env.EVERDICT_QUEUE_PRESSURE) } : {}),
    // Per-batch sink override validation (submit 400s on an unknown sink name; "none" is always allowed).
    sinkExists: async (tenant, name) =>
      ((await settingsStore.get(tenant))?.traceSinks ?? []).some((e) => e.name === name),
    // Queued-entry reclaim (supersede / speculation loser) — in-flight jobs stay Backend.kill's concern.
    cancelQueued: (predicate) => scheduler.cancelQueued(predicate),
    adoptCase: adoptCaseFn,
    killCase,
    ...(temporalBatchAddress
      ? {
          temporalBatches: new TemporalBatchDriver({
            address: temporalBatchAddress,
            // History-budget dial: settled cases per workflow execution before continue-as-new (default 500 in the workflow).
            ...(process.env.EVERDICT_TEMPORAL_BATCH_CONTINUE_EVERY
              ? { continueEvery: Number(process.env.EVERDICT_TEMPORAL_BATCH_CONTINUE_EVERY) }
              : {}),
            // Adaptive continue-as-new floor (event count) — the server's continueAsNewSuggested is primary.
            ...(process.env.EVERDICT_TEMPORAL_BATCH_ROTATE_HISTORY
              ? { rotateAtHistoryLength: Number(process.env.EVERDICT_TEMPORAL_BATCH_ROTATE_HISTORY) }
              : {}),
          }),
        }
      : {}),
    // runtime:"auto" — expand to every registered runtime id for the tenant (sharding across all of them).
    runtimesFor: async (tenant) => (await runtimeRegistry.list(tenant)).map((r) => r.id),
    requireRuntime: true, // policy (default): a batch with no runtime is 400 at submit — the API does not register local
    // Fan out a child run per case (sharing the same RunStore as a single run) — each case becomes an addressable run, hidden by default in the activity list.
    runStore,
    datasets: datasetRegistry,
    harnesses: harnessInstanceRegistry,
    judges: judgeRegistry,
    judgeRunner,
    budget,
    usage: usageMeter,
    ...(artifacts ? { artifacts } : {}),
    // Workspace default judge model (a per-request override wins): the batch eval's inline judge grader scores with this model.
    judgeFor: async (tenant) => (await settingsStore.get(tenant))?.judge,
    // Pull ingest: pull traces from the tenant's OTel/MLflow and score them. Credentials come from the tenant SecretStore (authSecret name).
    buildTraceSource,
    secretsFor: runtimeSecretsFor, // judge model key (shared secret)
    scopedSecretsFor, // resolve harness env {secretRef} (shared + submitter's personal)
    // Private-repo dataset (preferred): if the case git URL owner matches the workspace GitHub App installation, use that App token (same as a single run).
    installationTokenFor: (workspace, gitUrl) => githubAppService.tokenForRepo(workspace, gitUrl),
    // Workspace registry image pull credentials — batch cases attach the same way as a single run.
    registryAuthsFor: (workspace) => imageRegistryService.pullAuths(workspace),
    // Completion notification (Mattermost) — batch-eval completion posts to the channel just like a run.
    onComplete: (tenant, record) => notificationService.notifyScorecard(tenant, record),
    // Trace sink export — export judged detail results to the workspace observability platform (outcome recorded on record.export).
    exportResults: (tenant, ctx, results, attach) => traceSinkService.exportScorecard(tenant, ctx, results, attach),
    // A live batch streams the export the moment a case completes (after judging) (D5) — ingest keeps the batched exportResults above.
    exportStreamFor: (tenant, ctx) => traceSinkService.exportStream(tenant, ctx),
  });
}
