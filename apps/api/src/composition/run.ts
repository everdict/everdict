import type { GithubAppService } from "@everdict/application-control";
import type { ImageRegistryService } from "@everdict/application-control";
import type { NotificationService } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Dispatcher as CoreDispatcher, ExecStreamHandle } from "@everdict/backends";
import type { GradeContext, JudgeSpec } from "@everdict/contracts";
import type { RunStore, WorkspaceSettingsStore } from "@everdict/db";
import { makeGraders } from "@everdict/graders";
import type { HarnessInstanceRegistry, ModelRegistry, RubricRegistry } from "@everdict/registry";
import type { S3ArtifactStore } from "@everdict/storage";
import { buildTraceSource } from "@everdict/trace";
import type { PersistentBudget } from "../common/budget-tracker.js";
import type { LiveFrameStore } from "../common/live-frame-store.js";
import type { LiveLogStore } from "../common/live-log-store.js";
import { buildCodeJudgeJob, defaultJudgeRunner } from "../core/execution/judge-runner.js";
import type { ModelResolvingDispatcher } from "../core/execution/model-resolving-dispatcher.js";
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
  execInSandboxFn: (
    tenant: string,
    runtimeList: string | undefined,
    caseId: string,
    command: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number } | undefined>;
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
}

// Single-run service + its judge runner. The judge runner is returned too because ScorecardService reuses it.
export function buildRun(deps: {
  store: RunStore;
  meteredDispatcher: CoreDispatcher;
  dispatcher: ModelResolvingDispatcher;
  settingsStore: WorkspaceSettingsStore;
  harnessInstanceRegistry: HarnessInstanceRegistry;
  modelRegistry: ModelRegistry;
  rubricRegistry: RubricRegistry;
  budget: PersistentBudget;
  artifacts: S3ArtifactStore | undefined;
  runtimeSecretsFor: RuntimeSecretsFn;
  scopedSecretsFor: ScopedSecretsFn;
  githubAppService: GithubAppService;
  imageRegistryService: ImageRegistryService;
  notificationService: NotificationService;
  envMeterPolicy: (tenant: string) => boolean;
  preflightPlacement: PlacementPreflight;
  readers: RuntimeAccessReaders;
  // Latest live-screen frame per run, pushed by a self-hosted runner (report_case_screen). RunService.screen() serves it.
  liveFrames: LiveFrameStore;
  // Accumulated live execution log per run, pushed by a self-hosted runner (report_case_log). RunService.logs() serves it.
  liveLogs: LiveLogStore;
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
    artifacts,
    runtimeSecretsFor,
    scopedSecretsFor,
    githubAppService,
    imageRegistryService,
    notificationService,
    envMeterPolicy,
    preflightPlacement,
    readers,
    liveFrames,
    liveLogs,
  } = deps;
  const { readCaseLogsFn, execInSandboxFn, captureBrowserScreenFn, openTerminalStreamFn } = readers;

  const service = new RunService({
    // Lazy — the lane-resolving closure is built further down (after the runtime registry wiring).
    readCaseLogs: (tenant, runtimeList, caseId, stream) => readCaseLogsFn(tenant, runtimeList, caseId, stream),
    execInSandbox: (tenant, runtimeList, caseId, command) => execInSandboxFn(tenant, runtimeList, caseId, command),
    captureBrowserScreen: (tenant, runtimeList, runId) => captureBrowserScreenFn(tenant, runtimeList, runId),
    // Pushed frames (self-hosted) — RunService.screen() prefers this over the CDP pull for unreachable containers.
    liveFrame: (runId) => liveFrames.get(runId)?.frameBase64,
    // Pushed log (self-hosted) — RunService.logs() prefers this over the backend tail for unreachable runners.
    pushLogs: (runId) => liveLogs.get(runId),
    openTerminalStream: (tenant, runtimeList, caseId) => openTerminalStreamFn(tenant, runtimeList, caseId),
    dispatcher: meteredDispatcher,
    store,
    // Grader factory (@everdict/graders) for executeCase's control-plane collection-mode scoring — the application
    // layer never imports the grader impls, so the composition root supplies it (re-architecture P2 S3).
    makeGraders,
    budget,
    requireRuntime: true, // policy (default): a run with no runtime/self target is 400 at submit — the API does not register local
    preflightPlacement, // submit-time capability gate: reject a harness/runtime mismatch (e.g. Windows topology → Linux cluster) at 400
    ...(artifacts ? { artifacts } : {}),
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
    // Workspace registry image pull credentials — if the job image belongs to that registry, attach via job.registryAuth.
    registryAuthsFor: (workspace) => imageRegistryService.pullAuths(workspace),
    // Out-of-job trace collection (harness trace.collect="control-plane") — executeCase finalizes the traceRef result.
    buildTraceSource,
    secretsFor: runtimeSecretsFor, // pull auth for collection (re-resolve traceRef.authSecret)
    // Completion notification (Mattermost) — post to the channel when workspace notify settings exist. Failure is independent of the run result.
    onComplete: (tenant, record) => notificationService.notifyRun(tenant, record),
  });
  // Judge runner: a model judge (anthropic/openai) makes a real call with the tenant secret key; a harness judge dispatches a reference agent to render the verdict.
  // Skip (with a stated reason) if the key/secret is missing. An openai base (LiteLLM etc.) comes from the OPENAI_BASE_URL secret or env.
  const judgeRunner = defaultJudgeRunner({
    secretsFor: runtimeSecretsFor,
    dispatch: (job) => dispatcher.dispatch(job), // a harness judge also goes through tenant runtime routing
    harnesses: harnessInstanceRegistry,
    models: modelRegistry, // if judge.model is a registered model id, resolve provider/baseUrl/underlying-model (else a raw string)
    rubrics: rubricRegistry, // if judge.rubric is a {id, version} ref, resolve the registered rubric (text/criteria/template)
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
