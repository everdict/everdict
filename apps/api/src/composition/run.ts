import type { EnvelopeStore, GithubAppService, TrajectoryStore } from "@everdict/application-control";
import type { ImageRegistryService } from "@everdict/application-control";
import type { NotificationService, PlatformEventService } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { ExecutionAttemptStore, RecordingStore } from "@everdict/application-control";
import type { Dispatcher as CoreDispatcher, ExecStreamHandle } from "@everdict/backends";
import type { GradeContext, JudgeSpec, RegistryAuth, TraceEvent } from "@everdict/contracts";
import type { CasePlacement, TopologyStatus } from "@everdict/contracts/wire";
import type { RunStore, ScorecardStore, WorkspaceSettingsStore } from "@everdict/db";
import type { UsageMeter } from "@everdict/domain";
import { resolvePolicyResolution } from "@everdict/domain";
import { makeGraders } from "@everdict/graders";
import type { HarnessInstanceRegistry, ModelRegistry, RubricRegistry } from "@everdict/registry";
import type { S3ArtifactStore } from "@everdict/storage";
import { buildTraceSource } from "@everdict/trace";
import type { PersistentBudget } from "../common/budget-tracker.js";
import type { CaseFsRequestHub } from "../common/case-fs-request-hub.js";
import type { LiveFrameStore } from "../common/live-frame-store.js";
import type { LiveLogStore } from "../common/live-log-store.js";
import type { LiveTraceStore } from "../common/live-trace-store.js";
import { buildCodeJudgeJob, defaultJudgeRunner } from "../core/execution/judge-runner.js";
import type { PlacementPreflight } from "../core/execution/placement-preflight.js";
import type { RuntimeSecretsFn, ScopedSecretsFn } from "./types.js";

// Live-observability lane readers (from buildRuntimeAccess) — RunService wraps them in lazy closures.
export interface RuntimeAccessReaders {
  readCaseLogsFn: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    stream?: "stdout" | "stderr",
  ) => Promise<string | undefined>;
  readCaseEventsFn: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
  ) => Promise<TraceEvent[] | undefined>;
  execInSandboxFn: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    command: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
  screenEndpointFn: (tenant: string, runtimeList: string | undefined, runId: string) => Promise<string | undefined>;
  captureBrowserScreenFn: (
    tenant: string,
    runtimeList: string | undefined,
    runId: string,
  ) => Promise<string | undefined>;
  openTerminalStreamFn: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
  ) => Promise<ExecStreamHandle | undefined>;
  inspectCasePlacementFn: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
  ) => Promise<CasePlacement | undefined>;
  inspectTopologyFn: (
    tenant: string,
    runtimeList: string | undefined,
    harness: { id: string; version: string },
  ) => Promise<TopologyStatus | undefined>;
  topologyServiceLogsFn: (
    tenant: string,
    runtimeList: string | undefined,
    harness: { id: string; version: string },
    service: string,
  ) => Promise<string | undefined>;
}

// Single-run service + its judge runner. The judge runner is returned too because ScorecardService reuses it.
export function buildRun(deps: {
  store: RunStore;
  // Parent-policy resolution for scorecard CHILD runs (RunService.withVerdicts) — cross-resource data goes
  // through the owning STORE, never a peer service (api-layer rule).
  scorecardStore: ScorecardStore;
  envelopes: EnvelopeStore; // envelope spend ledger (§5.2 P4)
  trajectories: TrajectoryStore; // the owned trajectory store (P5 rung 1)
  // Cascade cancel (§5.5 O8) — late-bound to ScorecardService.cancelCausedBy (built after the run service).
  onAgentRunCancelled?: (tenant: string, runId: string) => Promise<unknown>;
  meteredDispatcher: CoreDispatcher;
  // 저지의 하네스 위임 경로가 쓰는 공유 디스패처 — dispatch 만 쓰므로 인터페이스에 의존한다(backends 규칙).
  dispatcher: CoreDispatcher;
  settingsStore: WorkspaceSettingsStore;
  harnessInstanceRegistry: HarnessInstanceRegistry;
  modelRegistry: ModelRegistry;
  rubricRegistry: RubricRegistry;
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
  envMeterPolicy: (tenant: string) => boolean;
  preflightPlacement: PlacementPreflight;
  readers: RuntimeAccessReaders;
  // Latest live-screen frame per run, pushed by a self-hosted runner (report_case_screen). RunService.screen() serves it.
  liveFrames: LiveFrameStore;
  // Accumulated live execution log per run, pushed by a self-hosted runner (report_case_log). RunService.logs() serves it.
  liveLogs: LiveLogStore;
  // Accumulated live trajectory per run (dispatch marks + report_case_trace pushes). RunService.liveTrace() serves it.
  liveTraces: LiveTraceStore;
  // Durable replay recording (optional) — RunService seals it at finalize and attaches the ref to the result.
  recordingStore?: RecordingStore;
  // The physical execution ledger (mig 0182) — a row per physical execution, Phase-1 dual-write.
  attempts?: ExecutionAttemptStore;
  // Run-workbench fs rendezvous (self-hosted lane) — parked reads the runner's in-case servicing loop answers.
  caseFsRequests?: CaseFsRequestHub;
}) {
  const {
    store,
    meteredDispatcher,
    dispatcher,
    settingsStore,
    harnessInstanceRegistry,
    modelRegistry,
    rubricRegistry,
    budget,
    usageMeter,
    artifacts,
    runtimeSecretsFor,
    scopedSecretsFor,
    githubAppService,
    registryAuthsFor,
    notificationService,
    platformEventService,
    envMeterPolicy,
    preflightPlacement,
    readers,
    liveFrames,
    liveLogs,
    liveTraces,
    recordingStore,
    attempts,
  } = deps;
  const {
    readCaseLogsFn,
    readCaseEventsFn,
    execInSandboxFn,
    captureBrowserScreenFn,
    screenEndpointFn,
    openTerminalStreamFn,
    inspectCasePlacementFn,
    inspectTopologyFn,
    topologyServiceLogsFn,
  } = readers;

  const service = new RunService({
    envelopes: deps.envelopes, // envelope spend ledger (§5.2 P4) — the causal admission leg + per-case draw-down
    ...(envelopeMaxInFlight() !== undefined ? { admissionMaxInFlight: envelopeMaxInFlight() } : {}),
    trajectories: deps.trajectories, // P5 dual-write — every settled trace seals in the owned store
    // A child run's verdict is derived under its PARENT's stamped/composed policy (RunService.withVerdicts).
    scorecardPolicy: async (tenant, scorecardId) => {
      const record = await deps.scorecardStore.get(scorecardId);
      if (!record || record.tenant !== tenant) return undefined;
      return resolvePolicyResolution(record.verdictPolicy, record.manifest?.verdictPolicy);
    },
    ...(deps.onAgentRunCancelled ? { onAgentRunCancelled: deps.onAgentRunCancelled } : {}),
    // Lazy — the lane-resolving closure is built further down (after the runtime registry wiring).
    readCaseLogs: (tenant, runtimeList, caseId, stream) => readCaseLogsFn(tenant, runtimeList, caseId, stream),
    execInSandbox: (tenant, runtimeList, caseId, command) => execInSandboxFn(tenant, runtimeList, caseId, command),
    // Self-hosted twin of execInSandbox for the workbench's repo reads — park on the hub, the runner answers.
    ...(deps.caseFsRequests
      ? {
          runnerCaseFs: {
            tree: async (runId: string) => {
              const answer = await deps.caseFsRequests?.request(runId, { kind: "fsTree" });
              return answer?.kind === "fsTree" ? answer.tree : undefined;
            },
            file: async (runId: string, path: string) => {
              const answer = await deps.caseFsRequests?.request(runId, { kind: "fsFile", path });
              return answer?.kind === "fsFile" ? answer.file : undefined;
            },
          },
        }
      : {}),
    captureBrowserScreen: (tenant, runtimeList, runId) => captureBrowserScreenFn(tenant, runtimeList, runId),
    screenEndpoint: (tenant, runtimeList, runId) => screenEndpointFn(tenant, runtimeList, runId),
    // Pushed frames (self-hosted) — RunService.screen() prefers this over the CDP pull for unreachable containers.
    liveFrame: (runId) => liveFrames.get(runId)?.frameBase64,
    // Pushed log (self-hosted) — RunService.logs() prefers this over the backend tail for unreachable runners.
    pushLogs: (runId) => liveLogs.get(runId),
    // Live trajectory (observability ⑨) — the dispatch marks + runner-pushed batches, plus the managed lane's
    // event-sentinel pull. RunService.liveTrace() merges both.
    liveTraceEvents: (runId) => liveTraces.get(runId),
    readCaseEvents: (tenant, runtimeList, caseId) => readCaseEventsFn(tenant, runtimeList, caseId),
    openTerminalStream: (tenant, runtimeList, caseId) => openTerminalStreamFn(tenant, runtimeList, caseId),
    // Case-scoped placement read (runtime debugging) — where the case's job stands inside its cluster.
    inspectCasePlacement: (tenant, runtimeList, caseId) => inspectCasePlacementFn(tenant, runtimeList, caseId),
    // Topology health roster + service logs (runtime debugging) — the warm service stack behind a service harness.
    inspectTopology: (tenant, runtimeList, harness) => inspectTopologyFn(tenant, runtimeList, harness),
    readTopologyServiceLogs: (tenant, runtimeList, harness, service) =>
      topologyServiceLogsFn(tenant, runtimeList, harness, service),
    dispatcher: meteredDispatcher,
    store,
    // Grader factory (@everdict/graders) for executeCase's control-plane collection-mode scoring — the application
    // layer never imports the grader impls, so the composition root supplies it (re-architecture P2 S3).
    makeGraders,
    budget,
    usage: usageMeter, // meter-only billing usage — single runs meter per (source × model), same as a scorecard child
    requireRuntime: true, // policy (default): a run with no runtime/self target is 400 at submit — the API does not register local
    preflightPlacement, // submit-time capability gate: reject a harness/runtime mismatch (e.g. Windows topology → Linux cluster) at 400
    ...(artifacts ? { artifacts } : {}),
    ...(recordingStore ? { recordingStore } : {}),
    ...(attempts ? { attempts } : {}),
    // Declarative harness: resolve template+pins from the instance registry and embed the spec in the job (built-in fallback if absent).
    resolveHarness: (tenant, id, version) => harnessInstanceRegistry.get(tenant, id, version),
    // Resolve harness env {secretRef} (shared + personal secrets) just before dispatch (no plaintext stored in the registry). Same as scorecard.
    scopedSecretsFor,
    // Per-workspace metering policy (a per-request override wins): the DB settings store first, else the env policy fallback.
    meterUsageFor: async (tenant) => (await settingsStore.get(tenant))?.meterUsage ?? envMeterPolicy(tenant),
    // Workspace default judge model (a per-request override wins): injected into the job so an inline judge grader scores with this model.
    judgeFor: async (tenant) => (await settingsStore.get(tenant))?.judge,
    // Private-repo seed (preferred): if the case git URL owner matches the workspace GitHub App installation, use that App token (team-shared).
    installationTokenFor: (workspace, gitUrl) => githubAppService.tokenForRepo(workspace, gitUrl),
    // Image pull credentials (managed grants + BYO registries) — the ones covering this job's images ride along.
    registryAuthsFor,
    // Out-of-job trace collection (harness trace.collect="control-plane") — executeCase finalizes the traceRef result.
    buildTraceSource,
    secretsFor: runtimeSecretsFor, // pull auth for collection (re-resolve traceRef.authSecret)
    // Completion notification (Mattermost) — post to the channel when workspace notify settings exist. Failure is independent of the run result.
    // Lifecycle facts (agent-automation A1) — run.submitted; completion facts flow through onComplete above.
    events: platformEventService,
  });
  // Judge runner: a model judge (anthropic/openai) makes a real call with the tenant secret key; a harness judge dispatches a reference agent to render the verdict.
  // Skip (with a stated reason) if the key/secret is missing. An openai base (LiteLLM etc.) comes from the OPENAI_BASE_URL secret or env.
  const judgeRunner = defaultJudgeRunner({
    secretsFor: runtimeSecretsFor,
    dispatch: (job) => dispatcher.dispatch(job), // a harness judge also goes through tenant runtime routing
    harnesses: harnessInstanceRegistry,
    models: modelRegistry, // if judge.model is a registered model id, resolve provider/baseUrl/underlying-model (else a raw string)
    rubrics: rubricRegistry, // if judge.rubric is a {id, version} ref, resolve the registered rubric (text/criteria/template)
    // Judge-execution evidence + metering: the judge's own activity seals as a judge:<id> plane on the judged
    // case's child run, and its LLM cost lands in the SAME meter + enforcement budget every other execution uses,
    // itemized under source "judge" (the vocabulary existed in the meter; this is its producer).
    trajectories: deps.trajectories,
    meterJudgeCost: (tenant, model, cost) => {
      usageMeter.record(tenant, "judge", model, cost, 0); // a judge verdict adds cost, never a metered evaluation
      budget.settle(tenant, cost); // enforcement budget sees it too (settle only — never blocks)
    },
    ...(process.env.EVERDICT_JUDGE_OPENAI_BASE_URL
      ? { openaiBaseUrl: process.env.EVERDICT_JUDGE_OPENAI_BASE_URL }
      : {}),
  });
  return { service, judgeRunner, submitCodeJudgeRun: codeJudgeRunSubmitter(service) };
}

// Code-judge dry-run promotion (JudgePreviewService.try): the wrapper job becomes a REAL standalone run — same
// submit policy as any run (requireRuntime/preflight/budget), inline harnessSpec (the synthetic no-op wrapper has
// no registry entry), placement = spec.runtime → else the source run's (re-score co-locate). Sanctioned seam:
// docs/architecture/execution-scoring-orchestration.md.
export function codeJudgeRunSubmitter(service: RunService) {
  return async (input: {
    tenant: string;
    spec: Extract<JudgeSpec, { kind: "code" }>;
    ctx: GradeContext;
    createdBy?: string;
  }) => {
    const built = buildCodeJudgeJob(input.spec, input.ctx, input.ctx.case.placement);
    return service.submit({
      tenant: input.tenant,
      ...(input.createdBy ? { submittedBy: input.createdBy } : {}),
      harness: built.harness,
      case: built.evalCase,
      trigger: "judge-preview",
      harnessSpec: built.harnessSpec,
      ...(built.judge ? { judge: built.judge } : {}),
    });
  };
}

// O7 in-flight cap override — one env knob for the gate's outstanding-runs backstop (default lives in the gate).
function envelopeMaxInFlight(): number | undefined {
  const raw = process.env.EVERDICT_ENVELOPE_MAX_INFLIGHT;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
