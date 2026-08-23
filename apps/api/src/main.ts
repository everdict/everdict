import { randomUUID } from "node:crypto";
import { lookup as lookupDnsCb } from "node:dns";
import { promisify } from "node:util";
import {
  CycleService,
  GithubIssueSync,
  InitiativeService,
  IssueLabelService,
  IssueService,
  KnowledgeEntryService,
  KnowledgeService,
  ProductDiscovery,
  ProductService,
  ProductVersionSync,
  ProjectService,
  SeriesEvaluator,
  type SeriesRunSubmitter,
  TaskService,
  TeamService,
  WorkflowStateService,
  collectDeferredTrace,
  registryLatestVersionResolver,
  seedFirstPartyAgents,
  settleOrphanSessionRuns,
  whenLeader,
} from "@everdict/application-control";
import { ApprovalService, CancellationCoordinator } from "@everdict/application-control";
import {
  EventConsumerRunner,
  mattermostConsumer,
  regressionWatch,
  runFeedConsumer,
  runWebhookConsumer,
  scorecardFeedConsumer,
  subscriptionReactionConsumer,
  trackerUpdateConsumer,
} from "@everdict/application-control";
import { ProxyService } from "@everdict/application-control";
import {
  FsService,
  RevisionedWorkspaceFs,
  SkillService,
  withOriginBacklink,
  withRegisteredFact,
  withTracePerception,
} from "@everdict/application-control";
import {
  CapabilityService,
  EnvironmentAdoptionService,
  type SeriesContractDeps,
  adoptedImageReach,
  firstPartyCatalogExtras,
  firstPartyDefaults,
  resolveSeriesContract as resolveSeriesContractFor,
} from "@everdict/application-control";
import type {
  CaseResult,
  EvalCase,
  ProductSeries,
  RegistryAuth,
  Score,
  VerifierInvocation,
  VerifierJob,
} from "@everdict/contracts";
import { UpstreamError } from "@everdict/contracts";
import {
  type SeriesContractResolution,
  evaluateGate,
  perTenantTrustZones,
  refuseGateForInputTrust,
} from "@everdict/domain";
import { makeGraders } from "@everdict/graders";
import { InMemoryWorkspaceFs } from "@everdict/storage";
import { CdpEnvironmentRecorder } from "@everdict/topology";
import { buildTraceSource } from "@everdict/trace";
import type { AgentTryRelay } from "./api/mcp-context.js";
import type { BrowserSessionProvisioner } from "./common/browser-session-provisioner.js";
import { CaseFsRequestHub } from "./common/case-fs-request-hub.js";
import { CaseRecorder } from "./common/case-recorder.js";
import { LiveFrameStore } from "./common/live-frame-store.js";
import { LiveLogStore } from "./common/live-log-store.js";
import { LiveTraceStore } from "./common/live-trace-store.js";
import { TerminalTicketStore } from "./common/terminal-ticket.js";
import { TicketStore } from "./common/ticket-store.js";
import { buildAuthenticator } from "./composition/authenticator.js";
import { deploymentCompute } from "./composition/compute-env.js";
import { buildDispatch } from "./composition/dispatch.js";
import { artifactStoreFromEnv, meterUsagePolicyFromEnv, workspaceFsFromEnv } from "./composition/env-policy.js";
import {
  buildBudgets,
  buildExecutionScheduling,
  buildObservability,
  startAutoscaler,
} from "./composition/execution-scheduling.js";
import { buildFileExecutionService } from "./composition/file-execution.js";
import { buildManagedImages } from "./composition/images.js";
import { buildIntegrations } from "./composition/integrations.js";
import { lateBoundEmitter, lateBoundIssueLinker } from "./composition/late-events.js";
import { deploymentNomad } from "./composition/nomad-env.js";
import { makePersistence } from "./composition/persistence.js";
import { REPLICA_ID } from "./composition/replica.js";
import { buildRun } from "./composition/run.js";
import { DeferredRecoverySweep, buildRuntimeAccess, runStartupRecovery } from "./composition/runtime-access.js";
import { buildRuntimeCompute } from "./composition/runtime-compute.js";
import { buildSandboxSessions } from "./composition/sandbox.js";
import { ScheduleServiceRef, wireScheduleService } from "./composition/schedule.js";
import { buildScorecard, modelBindingResolver } from "./composition/scorecard.js";
import {
  buildBrowserProfile,
  buildCatalog,
  buildCheckpoint,
  buildCiLink,
  buildMattermostCommand,
  buildQueue,
  buildSubscription,
  buildView,
  buildViewSnapshot,
} from "./composition/services.js";
import { startTopologyPoolAutoscaler } from "./composition/topology-autoscaler.js";
import { buildTrustZones } from "./composition/trust-zones.js";
import { buildWorkspace } from "./composition/workspace.js";
import { AgentMemberToolingService } from "./core/agent/agent-member-tooling-service.js";
import { AgentService } from "./core/agent/agent-service.js";
import { BrowserProfileCaptureService } from "./core/browser-profile/browser-profile-capture-service.js";
import { BrowserSessionService } from "./core/browser-session/browser-session-service.js";
import { buildPlacementPreflight } from "./core/execution/placement-preflight.js";
import { JudgePreviewService } from "./core/judge/judge-preview-service.js";
import { KnowledgeExtractionService } from "./core/knowledge/knowledge-extraction-service.js";
import { ModelService } from "./core/model/model-service.js";
import { OtlpIngestService } from "./core/observability/otlp-ingest-service.js";
import { DriverOpsService } from "./core/ops/driver-ops-service.js";
import { TemporalBatchDriver } from "./core/scorecard/temporal-batch-driver.js";
import { SecretUsageService } from "./core/secret/secret-usage-service.js";
import { SkillGenerator } from "./core/skill/skill-generator.js";
import { WorkspacePulseService } from "./core/workspace/workspace-pulse-service.js";
import { httpVerifierRunner } from "./infrastructure/agent/http-verifier-runner.js";
import { DockerBrowserProvisioner } from "./infrastructure/browser-session/docker-browser-provisioner.js";
import { LocalChromeProvisioner } from "./infrastructure/browser-session/local-chrome-provisioner.js";
import { runtimeSessionProvision } from "./infrastructure/browser-session/nomad-session-provision.js";
import { PooledBrowserProvisioner } from "./infrastructure/browser-session/pooled-browser-provisioner.js";
import { RoutingBrowserProvisioner } from "./infrastructure/browser-session/routing-browser-provisioner.js";
import { RuntimeBrowserProvisioner } from "./infrastructure/browser-session/runtime-browser-provisioner.js";
import {
  githubRepoTreeReaderFactory,
  githubRepoWriterFactory,
  githubVersionReaderFactory,
} from "./infrastructure/github/repo-writer.js";
import { installProxyDispatcher } from "./infrastructure/http/proxy-dispatcher.js";
import { probeMcpServer } from "./infrastructure/mcp/probe-mcp.js";
import { buildServer } from "./server.js";

// Parse an env var as a strictly-positive integer; undefined (unset/blank/zero/negative/NaN) ⇒ "no limit".
function positiveIntEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// Choose the interactive-browser-session provisioner from env (browser-profiles). See the call site for the modes.
// `remote` (pool of headless-shell sidecars) is the socket-free multi-user self-hosted path; `docker` launches a
// container per session (needs the host Docker socket); default is the host-Chrome LocalChromeProvisioner (dev).
function selectBrowserProvisioner(chromeBin: string | undefined): BrowserSessionProvisioner {
  const kind = process.env.EVERDICT_BROWSER_PROVISIONER;
  if (kind === "remote") {
    const pool = (process.env.EVERDICT_BROWSER_CDP_POOL ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return new PooledBrowserProvisioner({ pool });
  }
  if (kind === "docker")
    return new DockerBrowserProvisioner({
      ...(process.env.EVERDICT_BROWSER_IMAGE ? { image: process.env.EVERDICT_BROWSER_IMAGE } : {}),
      ...(process.env.EVERDICT_BROWSER_DOCKER_NETWORK ? { network: process.env.EVERDICT_BROWSER_DOCKER_NETWORK } : {}),
      // Host fonts → container (read-only). headless-shell has no CJK fonts; without this Korean pages are tofu.
      ...(process.env.EVERDICT_BROWSER_FONTS_DIR ? { fontsDir: process.env.EVERDICT_BROWSER_FONTS_DIR } : {}),
    });
  return new LocalChromeProvisioner(chromeBin ? { binary: chromeBin } : {});
}

// Multi-tenant control-plane server. tenant is derived from the Bearer API key (dev header fallback if absent).
// DATABASE_URL → Postgres (stores/keys/registries), else in-memory. NOMAD_ADDR → Nomad backend.
// main is the process composition root: env → per-concern builders (composition/*) → buildServer → start.
async function main(): Promise<void> {
  // Proxy-aware outbound: install a global dispatcher FIRST (before any client fetches) so every outbound call (LLM
  // providers, trace pull/export, GitHub App, Mattermost) honors HTTP(S)_PROXY / NO_PROXY behind a corporate proxy.
  // No-op when no proxy env is set.
  const proxy = installProxyDispatcher();
  if (proxy) console.log(`[everdict] outbound proxy: ${proxy.httpsProxy ?? proxy.httpProxy} (NO_PROXY honored)`);

  const port = Number(process.env.PORT ?? "8787");
  // THE deployment's Nomad — one block for BOTH lanes (composition/nomad-env). An eval case and a world
  // session are two modes of one placement target, so they must not be able to name two clusters.
  const nomad = deploymentNomad();
  // WHAT this deployment can hold open, and where (composition/compute-env) — one answer for agent worlds, the
  // harness playground and "Run this file", which used to ask separately and could disagree.
  const compute = deploymentCompute();
  const k8sContext = process.env.EVERDICT_K8S_CONTEXT;
  const image = process.env.EVERDICT_AGENT_IMAGE;

  const {
    store,
    recordingStore,
    caseReceiptStore,
    executionAttemptStore,
    cancellationStore,
    publicationOperationStore,
    scorecardStore,
    scoringStageStore,
    keyStore,
    harnessTemplateRegistry,
    harnessInstanceRegistry: rawHarnessInstanceRegistry,
    datasetRegistry: rawDatasetRegistry,
    benchmarkRegistry,
    judgeRegistry: rawJudgeRegistry,
    rubricRegistry,
    modelRegistry,
    agentRegistry,
    runtimeRegistry,
    settingsStore,
    workspaceStore,
    userProfileStore,
    inviteStore,
    secretStore,
    oauthStateStore,
    runnerStore,
    runnerJobStore,
    scheduleStore,
    notificationStore,
    platformEventStore,
    approvalStore,
    envelopeStore,
    eventConsumerStateStore,
    trajectoryStore: rawTrajectoryStore,
    commentStore,
    knowledgeStore,
    knowledgeEntryStore,
    fsRevisionStore,
    subscriptionStore,
    viewStore,
    handoffCheckpointStore,
    verificationDecisionStore,
    taskStore,
    teamStore,
    cycleStore,
    workflowStateStore,
    projectUpdateStore,
    issueStore,
    issueLabelStore,
    projectStore,
    initiativeStore,
    initiativeUpdateStore,
    productStore,
    releaseStore,
    capabilityGenerationStore,
    constitutionApprovalStore,
    constitutionalPublisher,
    productVersionStore,
    browserProfileStore,
    skillStore,
    skillVersionStore,
    capabilityStore,
    agentMemberPreferenceStore,
    callbackStore,
    usageStore,
    budgetStore,
    cipher,
    leader,
    replicas,
  } = await makePersistence();

  // Announce that this process is alive, before anything reads the live set: boot recovery on a PEER replica
  // must be able to see us, and our own ownership stamps mean nothing if nobody can tell we are running.
  await replicas.beat().catch(() => {});
  setInterval(() => void replicas.beat().catch(() => {}), 10_000).unref();

  // Elect the replica that runs the singleton control-plane loops (docs/architecture/multi-replica.md). Started
  // BEFORE the loops are registered so a boot-time pass placed after this knows whether it may act; with no
  // Postgres this is `soleLeader` and every gated loop simply runs, exactly as it did single-process.
  await leader.start();
  if (leader.isLeader()) console.log(`▶ control-plane leader: ${REPLICA_ID}`);

  // E2 content/registry facts (event-plumbing.md §3): registration is a state transition, so it emits its fact.
  // Decorated ONCE here — every caller (routes, MCP tools, bundle apply, benchmark import, CI re-pin) goes
  // through the same decorated instance; _shared seeds never emit. The platform-event service is built later
  // (buildIntegrations), so the decorators emit through a late-bound forwarder connected below.
  const lateEvents = lateBoundEmitter();
  // A capability that declares it was born from an issue links itself back to that issue — same choke point,
  // because the regression watch needs BOTH the dataset and the harness link to notice a closed issue degrading,
  // and a link nobody remembers to make is a watch that never fires. Only the three kinds an issue can link.
  const lateIssueLinks = lateBoundIssueLinker();
  const harnessInstanceRegistry = withRegisteredFact(
    withOriginBacklink(rawHarnessInstanceRegistry, "harness", lateIssueLinks),
    "harness.registered",
    "harness",
    lateEvents,
  );
  const datasetRegistry = withRegisteredFact(
    withOriginBacklink(rawDatasetRegistry, "dataset", lateIssueLinks),
    "dataset.registered",
    "dataset",
    lateEvents,
  );
  const judgeRegistry = withRegisteredFact(
    withOriginBacklink(rawJudgeRegistry, "judge", lateIssueLinks),
    "judge.registered",
    "judge",
    lateEvents,
  );
  // E4 perception (event-plumbing wave 4): every trajectory passes through seal, so the tenant's trace
  // thresholds are evaluated THERE — a crossing lands trace.threshold_crossed on the log and wakes whatever
  // subscribed (the continuous-operations loop's sensory half). Announce-once rides seal's `created`.
  const trajectoryStore = withTracePerception(rawTrajectoryStore, {
    thresholdsFor: async (tenant) => (await settingsStore.get(tenant))?.traceThresholds ?? [],
    events: lateEvents,
  });

  // First-party agent templates (agent-automation B4) — seed the two flagship automation agents into _shared
  // (idempotent; disabled + creator-less by design: a workspace adopts one by saving its own copy).
  await seedFirstPartyAgents(agentRegistry);

  // Latest-version resolution over the registries — backs the freshness decoration (skills / knowledge entries) and
  // task-time context assembly. Best-effort: an unknown/deleted entity resolves to "no signal", never an error.
  const latestVersionOf = registryLatestVersionResolver({
    datasets: datasetRegistry,
    judges: judgeRegistry,
    runtimes: runtimeRegistry,
    models: modelRegistry,
    rubrics: rubricRegistry,
    harnesses: harnessInstanceRegistry,
    agents: agentRegistry,
  });

  // The workspace filesystem — S3/MinIO when env-configured (distributed: every replica sees one tree), else
  // in-memory (dev). Same object storage as artifacts, namespaced under the "fs/" key prefix. Skill + knowledge
  // bodies live on it as the SSOT (content-projection); the Files page + fs tools browse it.
  const rawWorkspaceFs = (await workspaceFsFromEnv()) ?? new InMemoryWorkspaceFs();
  console.log(
    rawWorkspaceFs instanceof InMemoryWorkspaceFs
      ? "▶ workspace filesystem: in-memory (dev — set EVERDICT_S3_* for the distributed backend)"
      : "▶ workspace filesystem: S3/MinIO (distributed)",
  );
  // Versioning is wired ONCE, here: every consumer below (the Files surfaces, the agent's fs tools, the skill and
  // knowledge content projections) writes through this decorator, so each write publishes an attributed revision
  // and a write that declares its base can never silently overwrite a concurrent one. Nothing downstream opts in.
  const workspaceFs = new RevisionedWorkspaceFs(rawWorkspaceFs, fsRevisionStore, undefined, lateEvents);

  // Knowledge entries — reified claims (the knowledge layer's record). CRUD + verify; freshness-decorated reads.
  // Bodies live on the workspace filesystem (knowledge/<id>.md) with the DB row as the replica.
  const knowledgeEntryService = new KnowledgeEntryService({
    store: knowledgeEntryStore,
    latestVersionOf,
    fs: workspaceFs,
    events: lateEvents, // E2 knowledge facts (created/proposed/approved)
  });

  // Workspace knowledge graph — the query surface over the harvested graph + a pull reindex that harvests the
  // tenant-listable record stores into it, plus task-time context assembly over the knowledge-layer records
  // (skills + entries). The tracker stores are the INTENT stratum — the issue hub whose links/resolutions decide
  // which execution records (runs/scorecards) are materialised at all. See docs/architecture/knowledge-graph.md.
  const knowledgeService = new KnowledgeService({
    store: knowledgeStore,
    reindexSources: {
      scorecards: scorecardStore,
      runs: store,
      schedules: scheduleStore,
      issues: issueStore,
      projects: projectStore,
      initiatives: initiativeStore,
      teams: teamStore,
      cycles: cycleStore,
      datasets: datasetRegistry,
      judges: judgeRegistry,
      runtimes: runtimeRegistry,
      models: modelRegistry,
      rubrics: rubricRegistry,
      harnesses: harnessInstanceRegistry,
      agents: agentRegistry,
      skills: skillStore,
      knowledgeEntries: knowledgeEntryStore,
    },
    contextSources: {
      skills: skillStore,
      knowledgeEntries: knowledgeEntryStore,
      latestVersionOf,
    },
  });

  // The schedule↔membership↔scorecard construction cycle: MembershipService's member-removal hook needs the
  // late-built ScheduleService (it depends on ScorecardService). The hook closes over this reference, resolved by
  // wireScheduleService near the end of boot. See composition/schedule.ts.
  const scheduleRef = new ScheduleServiceRef();
  const { workspaceService, membershipService, profileService, runnerService } = buildWorkspace({
    workspaceStore,
    inviteStore,
    userProfileStore,
    runnerStore,
    scheduleRef,
  });

  // No first-party defaults are auto-seeded into _shared. The first-party harness/judge/rubric/model examples were
  // noise that cluttered every workspace's list and — being _shared-owned — couldn't be deleted from a workspace.
  // (Datasets/runtimes already followed this rule.) The _shared fallback mechanism itself stays, so a real shared
  // entity registered later still shows through; a workspace registers what it needs.

  // Per-tenant isolation for every dispatch — ONE policy for the process, chosen by the operator and
  // announced at boot (composition/trust-zones.ts). Resolved HERE, above the backends, because the
  // deployment-wide targets must apply it too: it also feeds the tenant-runtime lane, the sandbox sessions and
  // the interactive browser sessions below, so a tenant's eval jobs, its worlds and its live browsers are
  // isolated by the same rule rather than several nearby guesses.
  const { trustZones } = buildTrustZones();

  const { backends, scheduler, schedulingControl, autoscale, scalingTargets, tenantQuotas, admissionSlots } =
    buildExecutionScheduling({
      nomad,
      k8sContext,
      image,
      secretStore,
      runLedger: store, // the tenant quota is counted from the run ledger, not from this process's maps
      ...(trustZones ? { trustZones } : {}),
    });
  // M2 — runtime.circuit_opened rides the breaker's own closed→open transition (late-bound: the platform event
  // service is built after the scheduler). Key format is `${tenant}:${runtimeId}` — split on the FIRST colon
  // (the runtime half may itself carry colons, e.g. self:ws).
  const { metrics, breaker } = buildObservability(scheduler, {
    backends, // session-pool gauges walk the live backend roster at scrape time (rt: backends register dynamically)
    onBreakerOpen: (key) => {
      const sep = key.indexOf(":");
      if (sep <= 0) return;
      const tenant = key.slice(0, sep);
      const runtime = key.slice(sep + 1);
      void lateEvents
        .emit({
          workspace: tenant,
          kind: "runtime.circuit_opened",
          subject: { type: "runtime", id: runtime },
          payload: { runtime },
          message: `Runtime ${runtime} marked unhealthy — the spillover circuit opened (repeated infra failures)`,
        })
        ?.catch?.(() => {});
    },
  });
  // NOT leader-gated on purpose: `scalingTargets` are this process's own MutableSlots — its admission
  // envelope, not a shared resource. Gating it would pin every follower at the minimum slot count and leave it
  // unable to place work. Over-subscription across replicas is bounded by the orchestrator probe, which is the
  // cross-replica truth for slots (docs/architecture/multi-replica.md).
  startAutoscaler({ autoscale, scalingTargets, scheduler });
  // Elastic session pools — scale declared-scalable topology session services from pool saturation + backlog
  // (acts only on harnesses that declare acquire.capacity.scale, on runtimes that can scale one service).
  startTopologyPoolAutoscaler({ backends, scheduler, leader });
  const { budget, usageMeter } = await buildBudgets({ budgetStore, usageStore });

  // Artifact store (when env-configured): offload os-use screenshots to S3/MinIO → result records carry only a presigned URL (no base64 inline).
  // Unset → undefined → the service falls back to base64 inline (dev). Credentials are env secrets (never committed).
  const artifacts = await artifactStoreFromEnv();
  if (artifacts) console.log("▶ artifact store: S3/MinIO offload enabled (os-use screenshots)");
  // Durable replay recording — persistent by DEFAULT (Postgres when DATABASE_URL is set, else in-memory), from
  // persistence. The runner-lease MCP tees pushed frames/logs into it (self-hosted) and the managed topology backend
  // streams the browser's CDP events (network/console/nav + frames) into it, so a run can be REPLAYED after it settles;
  // RunService/scorecard seal it at finalize. Frames need an object store to offload; logs/tracks record regardless.
  // Built before buildDispatch so the managed topology backend can record into it. docs/architecture/replay.md.
  const caseRecorder = new CaseRecorder(recordingStore, artifacts);

  // Accumulated live trajectory per run (observability ⑨) — fed by the dispatch account's placement marks
  // (TraceRecordingDispatcher, so built before buildDispatch) and by self-hosted runner pushes
  // (report_case_trace) → served by RunService.liveTrace(). Ephemeral; the sealed trajectory is the record.
  const liveTraces = new LiveTraceStore();

  // Managed image store (optional) — the workspace's own image namespace + the registry's authorization server.
  // Unset env = a BYO-only deployment: both stay undefined and /v2/token answers 404.
  // Cross-tenant pull reach (M6) is bound AFTER the adoption service exists: the store needs reach, and reach
  // needs the store's coordinates to classify an image. The cycle is real, so the predicate is a thunk over a
  // holder the adoption wiring fills in — until then it denies, which is the same answer as running without M6.
  const imageReach: { resolve?: (tenant: string, ref: string) => Promise<boolean> } = {};
  // Late-bound for the same reason `imageReach` is: the BYO registry service is built by buildDispatch below,
  // and mirroring a PRIVATE source needs the credentials it resolves. Until bound, a mirror is anonymous —
  // which is exactly right for a public base and honestly fails for a private one.
  const sourcePullAuths: { resolve?: (tenant: string) => Promise<RegistryAuth[]> } = {};
  const {
    images: workspaceImages,
    imageTokenService,
    imageMirror,
    publishLayerSnapshot,
  } = buildManagedImages(process.env, {
    crossTenantPull: (tenant, ref) => (imageReach.resolve ? imageReach.resolve(tenant, ref) : Promise.resolve(false)),
    pullAuthsFor: (tenant) => (sourcePullAuths.resolve ? sourcePullAuths.resolve(tenant) : Promise.resolve([])),
  });
  // The workspace's coordinates in that store — what makes classifyImageRef able to answer "managed". One
  // definition, handed to every surface that classifies, so the store and the inventory never disagree.
  const managedCoordinates = (workspace: string) =>
    workspaceImages
      ? { host: workspaceImages.endpoint, namespace: workspaceImages.namespaceFor(workspace) }
      : undefined;

  // LATE-BOUND VERIFIER LANE (arch-review 56, Wave K), the same holder idiom `cascadeCancel` uses below: the
  // lane is resolved by `buildRuntimeAccess`, which runs after the dispatch chain is built. An unwired lane
  // still means the verdict is `unmeasured` — never grading in the agent's own container.
  const verifierLane: { fn: (job: VerifierJob) => Promise<VerifierInvocation> } = {
    fn: async () => {
      throw new Error("no verifier lane is wired");
    },
  };

  const {
    runnerHub,
    callbackRendezvous,
    runtimeSecretsFor,
    scopedSecretsFor,
    imageRegistryService,
    registryAuthsFor,
    runtimeBuildBackend,
    topologyConversationEnvironmentFor,
    dispatcher,
    meteredDispatcher,
    probeRuntime,
    inspectRuntime,
    controlRuntime,
    invalidateTenantBackends,
    releaseSelfRunnerBackend,
  } = buildDispatch({
    // LATE-BOUND, like `cascadeCancel` below: the verifier lane is resolved by `buildRuntimeAccess`, which
    // runs after this call. The holder is what lets the dispatch chain be built once while the lane it may
    // need is wired further down — an absent lane still means `unmeasured`, never grading in the agent's
    // own container (arch-review 56, Wave K).
    dispatchVerifier: (job) => verifierLane.fn(job),
    // The agent's half is staged here, before the verifier's container exists — the backend deletes the
    // agent's Job as soon as it has parsed the result, so until this write it lives only in memory.
    ...(artifacts ? { agentHalves: artifacts } : {}),
    ...(workspaceImages ? { images: workspaceImages } : {}),
    ...(trustZones ? { trustZones } : {}),
    callbackStore,
    secretStore,
    settingsStore,
    harnessInstanceRegistry,
    modelRegistry,
    runtimeRegistry,
    runnerStore,
    runnerJobStore,
    scheduler,
    backends,
    metrics,
    browserProfileStore, // browser-profiles S5 — eval-browser profile injection (resolve + owner-gate)
    cipher, // browser-profiles S5 — decrypt the profile's captured storageState
    caseRecorder, // replay ② — managed topology backend records the per-case browser's CDP events into the recording
    recordingStore, // replay ② — a self-hosted RE-lease opens its own attempt here (arch-review 41 P0-evidence)
    attempts: executionAttemptStore, // …and the physical ledger records that re-lease as its own row (mig 0182)
    liveTraces, // observability ⑨ — the dispatch account's placement marks tee into the live-trace buffer
  });
  // WHERE anything runs, answered once (composition/runtime-compute): the deployment's own compute, and any
  // workspace-registered runtime resolved with its cluster credentials and trust zone. Agent worlds, the
  // harness playground, "Run this file" and interactive browser sessions all come through here — four lanes
  // that each used to resolve a cluster themselves, and disagreed about credentials while doing it.
  const runtimeCompute = buildRuntimeCompute({
    runtimes: runtimeRegistry,
    secretsFor: runtimeSecretsFor,
    ...(trustZones ? { trustZones } : {}),
    backends,
    ...(compute ? { compute } : {}),
    ...(nomad ? { nomad } : {}),
    ...(image ? { jobImage: image } : {}),
  });

  // Revoking a runner drops its lazily-registered self:<owner>:<runnerId> placement backend (runner churn hygiene —
  // built here because the dispatcher is created after the workspace/runner services).
  runnerService.onRevoke = (owner, id) => releaseSelfRunnerBackend(owner, id);

  const envMeterPolicy = meterUsagePolicyFromEnv(); // default policy when the workspace has no DB setting
  const {
    notificationService,
    platformEventService,
    mattermostService,
    traceSinkService,
    traceSourceService,
    spanAttrMappingService,
    commentService,
    githubAppService,
  } = buildIntegrations({
    settingsStore,
    notificationStore,
    platformEventStore,
    commentStore,
    oauthStateStore,
    membershipService,
    runtimeSecretsFor,
  });
  // E2: connect the early-built fact producers (registries / fs / knowledge) to the real event service.
  lateEvents.bind(platformEventService);
  // E1 — one log, N durable cursors: the personal feed (bell) re-based onto the event log. The completion
  // facts carry exactly the old feed gate; the consumers write rows idempotently (nf-<eventId>), so replay
  // (cursor rewind) produces zero duplicate effects. Poll is the correctness path; dead letters are logged.
  const eventConsumers = new EventConsumerRunner({
    events: platformEventStore,
    state: eventConsumerStateStore,
    onDeadLetter: (consumer, event, error) =>
      console.error(`[events] dead-letter ${consumer} ← ${event.kind} ${event.id}: ${error}`),
  });
  eventConsumers.register(runFeedConsumer(notificationStore));
  eventConsumers.register(scorecardFeedConsumer(notificationStore));
  // The Mattermost channel rides the log too (the last direct notification path, re-based): completion +
  // report facts → workspace channel posts. E2's widened facts keep machine-fired coverage intact.
  eventConsumers.register(mattermostConsumer(notificationService));
  // A posted project/goal update is news for the people answerable for that work — until this consumer existed
  // it landed in a timeline nobody was watching, which made posting one a private act (docs/tracker.md).
  eventConsumers.register(
    trackerUpdateConsumer({ projects: projectStore, initiatives: initiativeStore, feed: notificationStore }),
  );
  // One Temporal client driver serves every CP-started workflow family (batch cancel aside): approvals'
  // durable WAIT, the session reaper, and the T-d reaction executor below.
  const workflowTemporal = process.env.EVERDICT_TEMPORAL_ADDRESS
    ? new TemporalBatchDriver({ address: process.env.EVERDICT_TEMPORAL_ADDRESS })
    : undefined;
  // E3 reactions: non-agent subscription reactions ride the same durable cursor — webhooks deliver inline,
  // reaction.kind="workflow" starts the durable T-d executor (skipped VISIBLY without Temporal). Agent
  // reactions stay the activation engine's jurisdiction.
  eventConsumers.register(
    subscriptionReactionConsumer({
      subscriptions: subscriptionStore,
      ...(workflowTemporal ? { startReactionWorkflow: (input) => workflowTemporal.startReaction(input) } : {}),
    }),
  );
  // A run's completion callback (mig 0171): recorded at submit, delivered off the run's own terminal fact.
  // On the durable cursor rather than inline in the settling process, so a refused settle calls nobody and a
  // restart between dispatch and settlement does not silently drop the caller's answer.
  eventConsumers.register(
    runWebhookConsumer({
      runs: store,
      // The resolver the SSRF check judges (see the consumer): a tenant-supplied name is not a destination.
      lookup: async (host) => (await lookupDns(host, { all: true, verbatim: true })).map((a) => a.address),
    }),
  );
  eventConsumers.start();

  // Durable agent approvals (agent-automation A6): the agent service parks over the internal bridge, members
  // decide via /approvals, and a decision is DELIVERED back to the live in-process wait through the agent
  // service's own internal surface. Delivery absent (no agent service configured) = record-only.
  const approvalAgentUrl = process.env.AGENT_SERVICE_URL;
  const approvalAgentToken = process.env.AGENT_INTERNAL_TOKEN;
  const approvalTemporal = workflowTemporal;
  const approvalService = new ApprovalService({
    store: approvalStore,
    events: platformEventService,
    ...(approvalTemporal
      ? {
          workflow: {
            start: (record) =>
              approvalTemporal.startApproval({
                approvalId: record.id,
                tenant: record.tenant,
                expiresAt: record.expiresAt,
              }),
            signalDecided: (id) => approvalTemporal.signalApprovalDecided(id),
          },
        }
      : {}),
    ...(approvalAgentUrl && approvalAgentToken
      ? {
          deliver: async (approval, decision) => {
            const res = await fetch(new URL("/internal/deliver-approval", approvalAgentUrl), {
              method: "POST",
              headers: { "content-type": "application/json", "x-internal-token": approvalAgentToken },
              body: JSON.stringify({
                sessionId: approval.sessionId,
                requestId: approval.requestId,
                decision: decision === "approve" ? "allow" : "deny",
              }),
            });
            if (!res.ok) return false;
            const json = (await res.json().catch(() => ({}))) as { delivered?: unknown };
            return json.delivered === true;
          },
          resume: async (approval, decision, decidedBy) => {
            const res = await fetch(new URL("/internal/resume-approval", approvalAgentUrl), {
              method: "POST",
              headers: { "content-type": "application/json", "x-internal-token": approvalAgentToken },
              body: JSON.stringify({
                workspace: approval.tenant,
                sessionId: approval.sessionId,
                decision: decision === "approve" ? "allow" : "deny",
                request: approval.request,
                ...(decidedBy !== undefined ? { decidedBy } : {}),
              }),
            });
            if (!res.ok) return false;
            const json = (await res.json().catch(() => ({}))) as { resumed?: unknown };
            return json.resumed === true;
          },
        }
      : {}),
  });

  // Stranded discussion answers (@everdict comments whose agent-side callbacks died — crash / severed detached
  // turn) → failed + asker ping. 15 min staleness safely exceeds the activity-tick cadence AND the approval-park
  // window (10 min, deny-on-expiry then resumes), so anything older is dead. Same sweep idiom as browser sessions.
  // Leader-gated: the sweep does not just settle the row, it PINGS the asker — on N replicas one dead turn
  // would notify them N times (docs/architecture/multi-replica.md).
  setInterval(
    whenLeader(leader, () => void commentService.sweepStuckAgentAnswers(15 * 60_000).catch(() => {})),
    60_000,
  ).unref();

  // Per-runtime backend access for already-dispatched cases (adoption/kill + live-observability lane reads). Built
  // before run/scorecard because their live-observability + supersede-kill wiring closes over these functions.
  const {
    adoptWorkFn,
    readCaseLogsFn,
    readCaseEventsFn,
    openTerminalStreamFn,
    captureBrowserScreenFn,
    screenEndpointFn,
    execInSandboxFn,
    inspectCasePlacementFn,
    inspectTopologyFn,
    topologyServiceLogsFn,
    killWork,
    killUnhandled,
    probeWork,
    dispatchVerifier,
  } = buildRuntimeAccess({
    runtimeRegistry,
    runtimeSecretsFor,
    runtimeBuildBackend,
    // …so a verifier's compute gets an attempt row like every other managed unit, which is what makes it
    // visible to the cancellation sweep (arch-review 57 P0-verifier).
    ...(executionAttemptStore ? { attempts: executionAttemptStore } : {}),
    // …and the SAME tenant budget gate the agent's half passes through the Scheduler. A verifier is a second
    // container per case, running the tenant's own task image — a batch's fan-out doubled a workspace's
    // container count with nothing to 402 against (arch-review 59 P1-high, rule `backends`: anything that
    // takes compute passes admission).
    admitVerifierCompute: budget,
    // …and a SLOT from the same fleet-wide ledger the Scheduler claims one from, under the same tenant quota.
    // The budget above limits SPEND; this limits how many containers a workspace holds at once, and a batch
    // with budget headroom used to place every verifier straight at the backend (arch-review 60 P1-high).
    verifierSlots: {
      // The WHOLE ledger, not two of its verbs: a permit is a 30-minute lease and a holder that cannot renew
      // is a holder that loses its slot while its container runs (arch-review 61 P1).
      ledger: admissionSlots.ledger,
      quotaFor: admissionSlots.quotaFor,
      newPermitId: () => `verify-${randomUUID()}`,
    },
  });
  verifierLane.fn = dispatchVerifier;

  // Submit-time placement capability gate — reject a run/scorecard (400) whose chosen runtime can't run the harness
  // (e.g. a Windows-service topology on a Linux-only cluster) before any case is dispatched (RuntimeDispatcher is the
  // per-case backstop). Resolves the harness spec + runtime spec from the registries; a no-op for self:* / unlabeled runtimes.
  const preflightPlacement = buildPlacementPreflight({
    resolveHarness: (tenant, id, version) => harnessInstanceRegistry.get(tenant, id, version),
    resolveRuntime: (tenant, id) => runtimeRegistry.get(tenant, id),
  });

  // Latest live-screen frame per run, pushed by a self-hosted runner (report_case_screen) → served by RunService.screen().
  const liveFrames = new LiveFrameStore();
  // Accumulated live execution log per run, pushed by a self-hosted runner (report_case_log) → served by RunService.logs().
  const liveLogs = new LiveLogStore();
  // Run-workbench fs rendezvous (self-hosted lane): fsTree/fsFile PARK here and the runner's in-case servicing
  // loop answers via the poll_case_fs_requests/answer_case_fs_request lease tools. In-memory, like the default hub.
  const caseFsRequests = new CaseFsRequestHub();
  // Cascade cancel (§5.5 O8) — late-bound: the scorecard service is built after the run service, so the
  // hook resolves through this holder (fires only at runtime, long after boot completes).
  const cascadeCancel: { fn?: (tenant: string, runId: string) => Promise<{ cancelled: number; failures: string[] }> } =
    {};
  const { service, judgeRunner, submitCodeJudgeRun } = buildRun({
    envelopes: envelopeStore,
    trajectories: trajectoryStore,
    caseReceipts: caseReceiptStore,
    // AWAITED inside the run's own teardown (arch-review 52, Wave 3) — a subtree that could not be revoked
    // keeps the parent run's cancellation operation owed instead of being lost to a void catch.
    onAgentRunCancelled: async (tenant, runId) =>
      (await cascadeCancel.fn?.(tenant, runId)) ?? { cancelled: 0, failures: [] },
    store,
    scorecardStore,
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
    readers: {
      readCaseLogsFn,
      readCaseEventsFn,
      execInSandboxFn,
      captureBrowserScreenFn,
      screenEndpointFn,
      openTerminalStreamFn,
      inspectCasePlacementFn,
      inspectTopologyFn,
      topologyServiceLogsFn,
    },
    liveFrames,
    liveLogs,
    liveTraces,
    caseFsRequests,
    // User stop (POST /runs/:id/cancel) — the run-scale twin of the batch teardown: kill the dispatched
    // managed job, drop the queued scheduler entry, revoke the self-hosted lease (the runner aborts the
    // in-flight case on its next heartbeat).
    //
    // A row with NO handle no longer widens to the case id (arch-review 53, legacy removal): a self-hosted
    // lane answers `absent` (the lease revocation is its whole teardown) and a managed lane answers
    // `unknown`, keeping the cancellation owed rather than certifying a quiet nobody observed.
    killUnhandled,
    // …and the exact-handle stop the attempt ledger makes reachable after a restart (arch-review 52, Wave 2).
    killWork,
    // The cancel TEARDOWN's durable owner, for the RUN lane too (mig 0186, arch-review 52 Wave 3): the
    // CANCELLED decision and the row saying its teardown is owed commit in one statement, so a crash before
    // the kill confirms leaves an operation the coordinator below sweeps.
    cancellations: cancellationStore,
    cancelQueued: (predicate) => scheduler.cancelQueued(predicate),
    cancelLeased: (predicate) => runnerHub.requestCancel(predicate),
    ...(recordingStore ? { recordingStore } : {}),
    // A re-drive begins a new attempt; the recorder serving this process stamps it from here on, and the
    // store refuses the previous attempt's appends (mig 0173).
    // …and the PHYSICAL ledger records that attempt unconditionally (mig 0182) — including the re-drive whose
    // recording claim is refused, which used to leave no row anywhere.
    attempts: executionAttemptStore,
  });

  const scorecardService = buildScorecard({
    publicationOperations: publicationOperationStore,
    publisherId: REPLICA_ID,
    scoringStageStore,
    // Submit refuses a dataset whose graders declare ground_truth without a recorded approval (mig 0165).
    ...(constitutionApprovalStore ? { constitutionApprovals: constitutionApprovalStore } : {}),
    ...(constitutionalPublisher ? { constitutionalPublisher } : {}),
    modelRegistry,
    envelopes: envelopeStore,
    trajectories: trajectoryStore,
    scorecardStore,
    runStore: store,
    ...(recordingStore ? { recordingStore } : {}),
    // The SAME handoff the standalone driver gets (mig 0173). It was wired there and not here, so a batch's
    // re-driven case raised the generation and then its producers went on stamping the old one — every
    // append refused, the recording silently empty. A fence only one caller knows about is an outage.
    // Where a case's canonical outcome is decided (mig 0175) — claimed at the commit, compared against the
    // ledger at the finalize while both are written.
    caseReceipts: caseReceiptStore,
    // …and every PHYSICAL attempt behind those receipts (mig 0182): the spillover duplicate, the speculation
    // loser and the retried dispatch, which the one-per-case receipt structurally cannot report.
    attempts: executionAttemptStore,
    // The cancel TEARDOWN's durable owner (mig 0184): the CANCELLED decision commits first, so a crash before
    // the teardown finishes leaves work with nobody to stop it. The row is what the reconciler below sweeps.
    cancellations: cancellationStore,
    meteredDispatcher,
    scheduler,
    runnerHub,
    breaker,
    metrics,
    settingsStore,
    ...(constitutionApprovalStore ? { constitutionApprovals: constitutionApprovalStore } : {}),
    ...(constitutionalPublisher ? { constitutionalPublisher } : {}),
    datasetRegistry,
    harnessInstanceRegistry,
    judgeRegistry,
    rubricRegistry,
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
  });
  cascadeCancel.fn = (tenant, runId) => scorecardService.cancelCausedBy(tenant, runId);

  // The deps are named so the deferred-retry sweep below drives the SAME services with the same authority —
  // a second bag would be a second protocol, and the two would drift (arch-review 56, Wave C).
  const recoveryDeps = {
    scorecardStore,
    store,
    scorecardService,
    service,
    // Boot recovery adopts by the HANDLE the attempt ledger holds. There is no case-id fallback any more
    // (arch-review 53, legacy removal): adoption decides what a receipt vouches for, and "the newest job of
    // this case" could be another run's. A row with no handle is re-dispatched or tombstoned instead.
    adoptWorkFn,
    workHandlesFor: async (executionId: string) =>
      (await executionAttemptStore.list(executionId)).flatMap((a) => (a.runtimeWork ? [a.runtimeWork] : [])),
    owner: REPLICA_ID,
    replicas,
    // …and where `withVerifierPass` staged the agent's half, so a run that crashed between its two halves is
    // MERGED rather than losing the verdict its verifier already produced (arch-review 60 follow-through).
    ...(artifacts ? { agentHalves: artifacts } : {}),
    // …and the physical ledger, so an attempt this recovery adopted stops reading as live work
    // (arch-review 61 P2-audit).
    ...(executionAttemptStore ? { attempts: executionAttemptStore } : {}),
    // …and THE REST OF THE CASE (arch-review 63 P0). The in-line path runs this after the dispatch — the
    // deferred trace pull, the evidence, the observation graders, the seal — and the recovery used to hand
    // the adopted result straight to the settle, so a crash changed what had been measured rather than when.
    // The same function, the same capabilities the run lane is given.
    completeRecovered: (tenant: string, caseSpec: EvalCase, result: CaseResult) =>
      collectDeferredTrace({ buildTraceSource, makeGraders, secretsFor: runtimeSecretsFor }, tenant, caseSpec, result),
  };
  const owedRecovery = await runStartupRecovery(recoveryDeps);
  // ── THE SWEEP THE DEFERRAL ASSUMED (arch-review 56, Wave C) ──────────────────────────────────────
  //
  // A record boot recovery could not decide about is left OPEN and claimed by this replica at a raised epoch,
  // which every other replica correctly reads as "somebody is driving this". Until this sweep existed, that
  // was true of the row and false of the world: an owner, a fence, and no driver, until the process
  // restarted. The comment beside the deferral said "the next sweep asks again" and there was none.
  //
  // Only the WORKLIST is retried, never the whole boot pass: that one claims and resumes every active record
  // whose owner is not another live replica, which after boot includes every batch this replica is driving.
  // Not leader-gated either — the debt belongs to the replica that claimed the record, and no other process
  // is permitted to act on it.
  //
  // The worklist and "is a pass running" are ONE state, so the timer drives an object rather than a closure
  // over a mutable binding. A pass resumes batches, so outliving 60 seconds is ordinary — and the previous
  // shape forked on exactly that, re-driving live work and writing a stale list back over what the running
  // pass had discharged (arch-review 58 P1, `DeferredRecoverySweep`).
  const deferredRecovery = new DeferredRecoverySweep(recoveryDeps, owedRecovery);
  setInterval(() => void deferredRecovery.tick(), 60_000).unref();
  // The cancel teardown's reconciler (mig 0184, arch-review 47 §5.2). Boot recovery above resumes batches
  // whose DRIVER died; this closes the other half — batches whose cancellation was decided and whose teardown
  // never finished. Registered here rather than inside runStartupRecovery because it is not a one-shot boot
  // pass: a teardown can also be orphaned by a crash minutes into normal operation, and the row it leaves
  // behind is only found by sweeping.
  //
  // Leader-gated, like the other sweeps that act on rows this process does not own — the teardown kills jobs
  // and settles children, and N replicas racing to do it repeats work for no gain. Boot pass first, so a
  // restart converges immediately instead of at the first tick.
  const cancellationCoordinator = new CancellationCoordinator({
    cancellations: cancellationStore,
    now: () => new Date().toISOString(),
    // ONE sweep, both kinds (arch-review 52, Wave 3). Each service hands the coordinator the idempotent
    // teardown for its own kind of target; the coordinator owns the ledger and knows nothing about batches
    // or runs. A kind with no teardown registered is LEFT OWED, never closed.
    teardowns: {
      scorecard: scorecardService.cancellationTeardown(),
      run: service.cancellationTeardown(),
    },
  });
  const reconcileCancellations = whenLeader(
    leader,
    () =>
      void cancellationCoordinator
        .reconcile()
        .then((closed) => {
          if (closed > 0) console.log(`▶ cancellation reconciler: converged ${closed} orphaned teardown(s)`);
        })
        .catch(() => {}),
  );
  setInterval(reconcileCancellations, 60_000).unref();
  reconcileCancellations();
  // The PUBLICATION outbox's reconciler (mig 0187, arch-review 52 Wave 4). A settlement's outward effects —
  // the mutable current-analysis alias and the trace-sink export — are owed by a plan written in the terminal
  // transaction and drained by the winner inline. A crash between the two leaves the plan durable and nobody
  // running it: the same gap the cancellation reconciler above closes for a teardown, so it is closed the same
  // way. Leader-gated for the same reason — the drain writes to the tenant's platform, and N replicas racing
  // to do it repeats an export for no gain. Boot pass first, so a restart converges immediately.
  const publications = scorecardService.publicationCoordinator();
  const reconcilePublications = whenLeader(
    leader,
    () =>
      void publications
        ?.reconcile()
        .then((published) => {
          if (published > 0) console.log(`▶ publication reconciler: published ${published} owed settlement(s)`);
        })
        .catch(() => {}),
  );
  setInterval(reconcilePublications, 60_000).unref();
  reconcilePublications();
  // One-shot legacy gap sweep (arch-review 51 P0): aborts decided before the settle owned its teardown row
  // (or in the best-effort era's crash window) have live children and no operation — hand them to the
  // reconciler once per boot. Leader-gated for the same reason the reconciler is.
  whenLeader(leader, () => {
    void scorecardService
      .sweepAbortedTeardownGaps()
      .then((requested) => {
        if (requested > 0)
          console.log(`▶ cancellation gap sweep: ${requested} unowned teardown(s) handed to the reconciler`);
      })
      .catch(() => {});
  })();

  const mattermostCommandService = buildMattermostCommand({ settingsStore, runtimeSecretsFor, scorecardService });
  const { benchmarkService, bundleService } = buildCatalog({
    datasetRegistry,
    benchmarkRegistry,
    harnessTemplateRegistry,
    harnessInstanceRegistry,
    judgeRegistry,
    rubricRegistry,
    modelRegistry,
    runtimeRegistry,
    secretStore,
  });
  const ciLinkService = buildCiLink({ settingsStore, githubAppService, runnerService });

  // Close the schedule cycle: build ScheduleService (it needs scorecardService) and publish it into scheduleRef so
  // the member-removal hook can resolve it. Nothing before this point invokes that hook (a member can only leave a
  // running server, long after boot). See composition/schedule.ts.
  // View captures — built before the schedule wiring because a report-mode fire accumulates one on every run.
  const viewSnapshotService = buildViewSnapshot({ viewStore, scorecardStore, workspaceFs });
  const scheduleService = wireScheduleService(scheduleRef, {
    scheduleStore,
    scorecardService,
    ...(traceSourceService ? { traceSourceService } : {}),
    notificationService, // report-mode fire completion fan-out (analysis-studio V4)
    viewSnapshotService, // report fires also accumulate the View's numbers on the workspace filesystem
    platformEventService, // E3: every fire lands schedule.fired on the log (time-driven agents subscribe to it)
    trajectoryStore, // N2: pull.source "everdict" = continuous evaluation over the OWNED store's rolling window
  });

  const queueService = buildQueue({
    scorecardStore,
    runStore: store,
    scheduleService,
    runtimeRegistry,
    datasetRegistry,
    runnerService,
    scheduler,
    breaker,
    tenantQuotas,
  });
  const viewService = buildView({ viewStore });
  // Handoff checkpoints (ownership O6). The ref resolvers and the run-creator linkage are bound HERE — the
  // service stays honest about what it can verify by only being handed resolvers that exist.
  const checkpointService = buildCheckpoint({
    handoffCheckpointStore,
    verificationDecisionStore,
    // The verifier runtime, when there is an agent service to run one in. Without it the service refuses a
    // verification request outright — "verification is a human act in this deployment" — which is the state a
    // reader can act on, unlike a verdict nobody produced.
    ...(approvalAgentUrl && approvalAgentToken
      ? { verifier: httpVerifierRunner({ agentUrl: approvalAgentUrl, internalToken: approvalAgentToken }) }
      : {}),
    runStore: store,
    scorecardStore,
    // The verifier pins evidence from the SAME read its tool serves — the service's hydrating get, which
    // rebuilds a dispatched batch's plane from its child runs (arch-review 29 P0).
    readScorecardEvidence: (id: string) => scorecardService.get(id),
    // issue + file are everdict-HELD records — resolvable, so "unverifiable" stays reserved for what we
    // genuinely cannot check (a tenant's git commit, a foreign platform's trace).
    issueStore,
    workspaceFs,
    events: platformEventService,
  });
  // Workspace task ledger (agent-teams): lifecycle facts (task.created/claimed/completed/cancelled) are
  // emitted here — the single choke point both transports call; created/completed are trigger-matchable.
  const taskService = new TaskService({ store: taskStore, events: platformEventService });
  // The eval tracker (docs/tracker.md). IssueService is the single choke point for tracker facts: every
  // transition (member, MCP, and later the regression watch) stamps and persists through it, so no transport
  // can produce a fact-less move. The scorecard store rides along to validate resolution evidence and to build
  // an issue's evaluation history.
  // The GitHub half is a COLLABORATOR of IssueService, and IssueService is what it calls back into for
  // transitions. The two therefore reference each other: a holder breaks the construction order without
  // weakening the "one choke point for facts and pushes" invariant — the pusher closure reads the holder at
  // CALL time, by which point it is populated.
  const githubSyncRef: { current?: GithubIssueSync } = {};
  // Teams come first: they are the allocator IssueService calls to resolve an owning team and mint ENG-12.
  // A team's board — seeded when a team is born, edited from Settings › Teams.
  const workflowStateService = new WorkflowStateService({ store: workflowStateStore, issues: issueStore });
  const teamService = new TeamService({
    store: teamStore,
    workflowStates: workflowStateService,
    issues: issueStore,
    events: platformEventService,
  });
  // The label registry the tracker classifies with — also the name→id resolver a GitHub import needs.
  const issueLabelService = new IssueLabelService({
    labels: issueLabelStore,
    events: platformEventService,
  });
  const issueService = new IssueService({
    store: issueStore,
    teams: teamService,
    scorecards: scorecardStore,
    // "Does this cycle exist, and whose is it" — the only question an issue asks about an iteration.
    cycles: cycleStore,
    // "Is this checkpoint one of that project's" — the same question about a milestone.
    projects: projectStore,
    // "Which column is this, and whose board" — moving an issue by board column.
    states: workflowStateStore,
    // Read-only, for the list row's thread badge — one batched count per page, never a read per row.
    comments: commentStore,
    events: platformEventService,
    github: { pushStatus: async (record, actor) => githubSyncRef.current?.pushStatus(record, actor) },
  });
  // Connect the registries' origin backlink now that the tracker exists (construction-order forwarder, like
  // lateEvents): from here on, registering a capability stamped `from: {type:"issue"}` also links it there.
  lateIssueLinks.bind(issueService);
  // Absent GitHub App config just means the sync routes answer 404 — the local tracker is unaffected.
  const githubIssueSync = new GithubIssueSync({
    store: issueStore,
    issues: issueService,
    teams: teamService,
    tokens: githubAppService,
    writers: githubRepoWriterFactory(),
    labels: issueLabelService,
    ...(process.env.WEB_BASE_URL ? { webBaseUrl: process.env.WEB_BASE_URL } : {}),
  });
  githubSyncRef.current = githubIssueSync;
  // The regression watch closes the tracker's loop: a resolved issue whose evaluation later degrades reopens
  // itself as `regressed` and finds its owner in the bell. Registered here (after IssueService exists) rather
  // than beside the feed consumers — the runner picks up a late registration on its next tick, and the
  // consumer's own cursor makes that indistinguishable from having been there since start.
  eventConsumers.register(
    regressionWatch({
      issues: issueStore,
      issueService,
      // The RAW row is enough now (arch-review 43): the watch reads decisionPassRate over the persisted
      // aggregates — no plane, no hydration — so the reference-stored (child-backed) shape every normal
      // batch has works directly.
      scorecards: scorecardStore,
      feed: notificationStore,
    }),
  );
  // A team's iterations. Composed before the issue service so an issue can validate the cycle it names.
  const cycleService = new CycleService({
    store: cycleStore,
    teams: teamStore,
    issues: issueStore,
    events: platformEventService,
  });
  const projectService = new ProjectService({
    store: projectStore,
    issues: issueStore,
    // A project's team/initiative edges are validated against these on write — store reads, never peer-service
    // calls. The one thing a store cannot answer is "which team does work land on when the caller names none":
    // the workspace's default may still have to be minted, so that goes through the same TeamService seam
    // filing an issue uses (a project always names at least one team).
    teams: teamStore,
    defaultTeam: teamService,
    initiatives: initiativeStore,
    // The posted-update timeline — the project's health is what the latest one said.
    updates: projectUpdateStore,
    events: platformEventService,
  });
  const initiativeService = new InitiativeService({
    store: initiativeStore,
    projects: projectStore,
    issues: issueStore,
    // The goal's own posted-update timeline — its health is what the latest one said.
    updates: initiativeUpdateStore,
    events: platformEventService,
  });
  // The product timeline (docs/architecture/product-timeline.md) — Product ⊃ Release over the imported
  // version ledger. Series refs are validated against the registries at write time (a dangling id here would
  // not fail loudly — it would fail every auto-run and read as "the product got worse"). The sync pulls
  // GitHub releases/tags through the workspace App and fans genuinely new versions out into the watch
  // series' scorecards, stamped with product/series/version provenance (the trend's x-axis key).
  // WHAT A WATCH SERIES ASKS TODAY, concretely (arch-review 13 P0). A series' refs may omit the version,
  // which means "latest at run time" — so the contract underneath a series can move with the product row
  // untouched, and neither the row's version nor its policy digest can see it. Wiring the registries here,
  // at the one place that knows them, keeps the SUBMIT stamp and the READINESS comparison on one function.
  //
  // Resolved by the SAME sealers a scorecard manifest uses (arch-review 15 P1-5) — this was a second,
  // hand-rolled resolver that had already drifted into a weaker answer (no service models, no delegated judge
  // harness, no spec digest), so a release could ship against a "held" contract the manifest already knew had
  // moved. One resolution, two policies: the manifest records a hole honestly, the gate refuses on one.
  const seriesContractDeps: SeriesContractDeps = {
    datasets: datasetRegistry,
    harnesses: harnessInstanceRegistry,
    judges: judgeRegistry,
    rubrics: rubricRegistry,
    resolveModelBinding: modelBindingResolver(modelRegistry),
    // …and the model DOCUMENT reader, so the gate seals the same closure submit does (arch-review 21 P1).
    // Without it the resolver produced refs with no digests while the manifest produced both, and a series
    // naming a registered model would fail its own freshness check — the fail-closed direction, but an
    // availability defect all the same: auto-eval on a product's own contract could never read fresh.
    models: modelRegistry,
    // The workspace default judge model — the same source submit seals into `manifest.judgeRun`.
    judgeFor: async (tenant) => (await settingsStore.get(tenant))?.judge,
  };
  const resolveSeriesContract = (tenant: string, series: ProductSeries): Promise<SeriesContractResolution> =>
    resolveSeriesContractFor(seriesContractDeps, tenant, series);
  // Turning a watch series into a scorecard. ONE collaborator, three triggers (an import fan-out, the seed a
  // declaration owes itself, a member asking) — so a batch is stamped by one piece of code whichever door it
  // came through, and the submit seam below is the only place that knows about ScorecardService.
  const submitSeriesRun: SeriesRunSubmitter = async (input) =>
    scorecardService.submit({
      tenant: input.tenant,
      submittedBy: input.submittedBy,
      dataset: { id: input.dataset.id, version: input.dataset.version ?? "latest" },
      harness: { id: input.harness.id, version: input.harness.version ?? "latest" },
      judges: input.judges.map((judge) => ({ id: judge.id, version: judge.version ?? "latest" })),
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      // The caller's resolution, held over submit's own seal (arch-review 16 P0-3).
      ...(input.expectedContractDigest !== undefined ? { expectedContractDigest: input.expectedContractDigest } : {}),
      origin: input.origin,
    });
  const seriesEvaluator = new SeriesEvaluator({
    releases: releaseStore,
    submitSeriesRun,
    // The SAME resolver the readiness read uses — one function, so the stamp a batch carries and the contract
    // a release compares it against can never be produced by two different answers.
    resolveSeriesContract,
  });
  const productService = new ProductService({
    store: productStore,
    // The capability resolution generations a ship's commit conditions on (mig 0163) — Postgres only, since
    // the fence is a subquery over the generation table. Without a database the other conditions still hold.
    ...(capabilityGenerationStore ? { capabilityGenerations: capabilityGenerationStore } : {}),
    releases: releaseStore,
    versions: productVersionStore,
    issues: issueStore,
    scorecards: scorecardStore,
    // The release gate's evidence seam (arch-review 7 P0): a series' release verdict IS the scorecard
    // gate's decision — the same diff + evaluateGate a CI release gate runs, maxRegressions 0. The product
    // layer composes trust-kernel decisions; it never re-derives "better or worse" from bare pass rates.
    // …and it hands back the PINS IT READ (arch-review 10 P0). `diffSnapshot` captures both records at the
    // one read the diff was computed from, so the release records the judgment its verdict came from — not
    // whatever a separate trend-list read saw a moment earlier, which a re-score landing in between made a
    // different judgment entirely.
    seriesGate: async (tenant, baselineId, candidateId) => {
      // TRUST BEFORE ARITHMETIC (arch-review 51 P1): the release lane runs under the strictest policy —
      // receipt-vouched input only, no waiver — and an untrusted pin refuses BEFORE the diff is computed,
      // so no regression count derived from unauthoritative input ever exists to leak into readiness
      // reasons or issue automation. The pins the refusal read ride back exactly like the snapshot's would.
      const pins = await scorecardService.comparisonPins(tenant, baselineId, candidateId);
      const refusal = refuseGateForInputTrust(pins, { maxRegressions: 0 });
      if (refusal !== undefined) {
        return {
          decision: refusal.decision,
          reasons: refusal.reasons,
          ...(pins.baseline !== undefined ? { baselineScoring: pins.baseline } : {}),
          ...(pins.candidate !== undefined ? { candidateScoring: pins.candidate } : {}),
        };
      }
      const snapshot = await scorecardService.diffSnapshot(tenant, baselineId, candidateId, {});
      const evaluation = evaluateGate(snapshot.diff, { maxRegressions: 0 });
      return {
        decision: evaluation.decision,
        reasons: evaluation.reasons,
        ...(snapshot.baseline.pin !== undefined ? { baselineScoring: snapshot.baseline.pin } : {}),
        ...(snapshot.candidate.pin !== undefined ? { candidateScoring: snapshot.candidate.pin } : {}),
      };
    },
    capabilities: {
      hasDataset: async (tenant, id) => (await datasetRegistry.versions(tenant, id)).length > 0,
      hasHarness: async (tenant, id) => (await harnessInstanceRegistry.versions(tenant, id)).length > 0,
      hasJudge: async (tenant, id) => (await judgeRegistry.versions(tenant, id)).length > 0,
    },
    // The timeline's capability lane — when each version of a watched harness/dataset/judge was registered,
    // read from the same registries the refs validate against. A dangling id answers an empty map, and a
    // registry impl without the (optional) read degrades to the same honest empty.
    capabilityVersions: async (tenant, kind, id) =>
      (kind === "dataset"
        ? await datasetRegistry.versionDates?.(tenant, id)
        : kind === "harness"
          ? await harnessInstanceRegistry.versionDates?.(tenant, id)
          : await judgeRegistry.versionDates?.(tenant, id)) ?? {},
    resolveSeriesContract,
    // Declaring a series seeds its first evaluation, and a member can ask for one at any time — until this
    // seam existed a series only ever ran off a genuinely new import, so one declared on an already-backfilled
    // product stayed empty while the release gate read that emptiness as `not_evaluated`.
    seriesEvaluator,
    events: platformEventService,
  });
  const productVersionSync = new ProductVersionSync({
    resolveSeriesContract,
    products: productStore,
    releases: releaseStore,
    versions: productVersionStore,
    tokens: githubAppService,
    readers: githubVersionReaderFactory(),
    submitSeriesRun,
    events: platformEventService,
  });
  // The creation wizard's evidence read (docs/architecture/product-timeline.md §declaring by choosing): the
  // repository's own version streams + the deployable units in its tree, through the SAME App token the sync
  // uses — so a proposed service is one the sync can actually reach, not a suggestion that 404s on first pull.
  const productDiscovery = new ProductDiscovery({
    tokens: githubAppService,
    readers: githubVersionReaderFactory(),
    trees: githubRepoTreeReaderFactory(),
  });
  // The background pull (docs/architecture/product-timeline.md): everdict stays the client, so a sweep — not
  // a webhook — keeps the version ledger close to GitHub. The watermark keeps a quiet pass at one or two
  // GitHub reads per tracked service; a product with no services costs nothing. Not leader-gated: the ledger
  // is insert-once by natural key, so two replicas racing import each version exactly once and only one
  // replica's facts land — the same reasoning the retention sweeps give.
  const sweepProductVersions = async (): Promise<void> => {
    const products = await productStore.listAll(200).catch(() => []);
    for (const product of products) {
      if (product.services.length === 0) continue;
      await productVersionSync.sync(product.tenant, product.id, { subject: "everdict:product-sync" }).catch(() => {}); // per-service errors are already recorded on the product's sync state
    }
  };
  setInterval(() => void sweepProductVersions(), 900_000).unref(); // 15 min — release cadence, not a queue
  // The home screen's one read (docs/architecture/workspace-pulse.md) — how the workspace is doing, across every
  // axis at once. Composed from STORES rather than from the services above: the pulse only counts, and routing a
  // count through five peer services would be five services' worth of coupling for arithmetic none of them owns.
  const workspacePulseService = new WorkspacePulseService({
    issues: issueStore,
    cycles: cycleStore,
    projects: projectStore,
    initiatives: initiativeStore,
    tasks: taskStore,
    approvals: approvalStore,
    scorecards: scorecardStore,
    events: platformEventStore,
  });
  const subscriptionService = buildSubscription({ subscriptionStore, agentRegistry });
  // Reverse secret-usage index (GET /secrets/usage) — reads the registries + settings to annotate each workspace
  // secret with its live reference sites. Read-only; scans latest specs per request (nothing cached).
  const secretUsageService = new SecretUsageService({
    secrets: secretStore,
    harnesses: harnessInstanceRegistry,
    models: modelRegistry,
    runtimes: runtimeRegistry,
    settings: settingsStore,
  });
  const browserProfileService = buildBrowserProfile({ browserProfileStore });

  const terminalTickets = new TerminalTicketStore();
  // Separate store from the terminal's: a ticket minted to open a shell must never be replayable to take over a browser.
  const screenTickets = new TerminalTicketStore();
  // Interactive browser sessions (browser-profiles S1) — env-gated. The provisioner is selectable:
  //   • EVERDICT_BROWSER_PROVISIONER=remote — LEASE a whole browser from a fixed pool of headless-shell sidecars
  //     (EVERDICT_BROWSER_CDP_POOL, comma-separated CDP bases). No host Chrome, no Docker socket, no docker CLI —
  //     the api reaches each sidecar over the compose/cluster network by name. The easy multi-user self-hosted path.
  //   • EVERDICT_BROWSER_PROVISIONER=docker — LAUNCH a headless-Chromium container per session (needs the host
  //     Docker socket + a control plane running on the docker host; not the containerized compose stack).
  //   • else — the host-Chrome LocalChromeProvisioner (dev).
  const browserSessionsEnabled = process.env.EVERDICT_BROWSER_SESSIONS === "1";
  const browserTickets = browserSessionsEnabled ? new TicketStore() : undefined;
  const browserChromeBin = process.env.EVERDICT_BROWSER_CHROME_BIN; // override the launched binary (e.g. chromium)
  // Workspace BYO egress proxy pool (browser-profiles S4) — a country resolves to the login browser's --proxy-server.
  const proxyService = new ProxyService({ settings: settingsStore, secretsFor: runtimeSecretsFor });
  const browserProvisioner: BrowserSessionProvisioner = selectBrowserProvisioner(browserChromeBin);
  // Runtime binding (browser-profiles S9) — a session with a `runtime` runs the browser on the tenant's registered
  // runtime inside that tenant's trust zone (per-tenant network isolation; reachable from a containerized control
  // plane), else the host provisioner above. Nomad ships first; K8s / self-hosted are follow-ups.
  const runtimeBrowserProvisioner = new RuntimeBrowserProvisioner({
    // The SAME resolver world sessions and file runs go through — one answer to which cluster, which cluster
    // credential and which trust zone, instead of one per lane.
    resolve: (tenant, id) => runtimeCompute.resolve(tenant, id),
    provisionOnRuntime: runtimeSessionProvision(),
  });
  const routingBrowserProvisioner = new RoutingBrowserProvisioner(browserProvisioner, runtimeBrowserProvisioner);
  // Concurrent live-session caps (browser-profiles S8) — each session is a real browser process/container on this
  // node, so bound them so one tenant (or the fleet) can't exhaust the host. Unset ⇒ unlimited (single-tenant/dev).
  const browserMaxPerTenant = positiveIntEnv(process.env.EVERDICT_BROWSER_MAX_SESSIONS_PER_TENANT);
  const browserMaxTotal = positiveIntEnv(process.env.EVERDICT_BROWSER_MAX_SESSIONS);
  // Community-instance policy: let any member (not just an admin) publish a capability to the instance-wide public
  // catalog. Off by default (public stays admin-gated). See docs/architecture/capability-store.md.
  const allowMemberPublicPublish = process.env.EVERDICT_ALLOW_MEMBER_PUBLIC_PUBLISH === "1";
  const browserSessionService = browserSessionsEnabled
    ? new BrowserSessionService(routingBrowserProvisioner, {
        resolveProxy: (ws, country) => proxyService.resolve(ws, country),
        // O6: a live browser is a session RUN. Same ledger as an agent world, so a control plane that dies
        // leaves a record of the container it was holding instead of only an orphan on someone's cluster.
        runs: store,
        ...(lateEvents ? { events: lateEvents } : {}),
        budget, // and the same tenant budget gate — a live browser is compute someone pays for

        ...(browserMaxPerTenant !== undefined ? { maxPerTenant: browserMaxPerTenant } : {}),
        ...(browserMaxTotal !== undefined ? { maxTotal: browserMaxTotal } : {}),
        // Replay ② for the browser-session LANE (docs/architecture/replay.md): stream the session browser's
        // CDP environment plane (network/console/nav + frames) into the durable recording keyed by the session
        // run's derived runId, and seal it at close — a settled interactive session then replays like a settled
        // eval (and scrubs live via peek meanwhile). Both halves are best-effort by contract.
        recorder: (cdpBase, runId) => {
          // frames ON (opt-in on the recorder): an interactive session is often idle network-wise — the
          // screencast is what makes its replay show anything at all (live-found: an idle page recorded zero).
          const rec = new CdpEnvironmentRecorder(
            cdpBase,
            {
              // A browser session records ONCE — it has a single attempt, and 0 is that attempt said out
              // loud rather than left to a default somebody could change (review 39, Phase 4).
              track: (item) => void caseRecorder.recordTrack(runId, item, 0),
              frame: (frameBase64) => void caseRecorder.recordFrame(runId, frameBase64, 0),
            },
            { frames: true },
          );
          rec.start().catch(() => undefined); // a page-less browser records nothing, never a failed session
          return { stop: () => rec.stop() };
        },
        ...(recordingStore
          ? // A browser session records once — its own attempt is 0, said out loud rather than left absent.
            { sealRecording: (runId: string) => recordingStore.seal(runId, { envKind: "browser" }, 0) }
          : {}),
      })
    : undefined;
  if (browserSessionService) {
    // NOT leader-gated, deliberately: this tears down the browser processes THIS node holds, which is a fact
    // about this machine — a follower that stopped reaping its own sessions would leak them.
    setInterval(() => browserSessionService.sweep(), 60_000).unref(); // TTL teardown (live entries)
    // The ledger half: settle rows a dead process left `running` past their deadline (zombie prevention).
    // Leader-gated — it acts on rows this process does not own, and the facts it emits must fire once.
    setInterval(
      whenLeader(leader, () => void browserSessionService.sweepOrphans().catch(() => {})),
      60_000,
    ).unref();
    if (leader.isLeader()) void browserSessionService.sweepOrphans().catch(() => {}); // boot pass — reclaim what the LAST process leaked
  }
  // N3 retention: operator-configured TTL over the owned trajectory store (unset = keep forever). Hourly
  // sweep, logged — evidence never leaves silently.
  const retentionDays = positiveIntEnv(process.env.EVERDICT_TRAJECTORY_RETENTION_DAYS);
  if (retentionDays !== undefined) {
    const sweepTrajectories = async (): Promise<void> => {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000).toISOString();
      const removed = await trajectoryStore.deleteOlderThan(cutoff).catch(() => 0);
      if (removed > 0)
        console.log(`▶ trajectory retention: removed ${removed} sealed trajectories older than ${cutoff}`);
    };
    // Not leader-gated: one `DELETE … WHERE sealed_at < cutoff` is atomic and idempotent, so a second replica's
    // pass finds nothing left to remove (docs/architecture/multi-replica.md).
    setInterval(() => void sweepTrajectories(), 3_600_000).unref();
  }
  // EO4 retention: operator-configured TTL over the platform-event log (unset = keep forever). The TTL must
  // exceed max consumer lag + the replay window (event-plumbing §4) — pruning is the operator saying "I no
  // longer need to replay past this". Hourly sweep, logged; provenance survives (runs embed their origin).
  const eventRetentionDays = positiveIntEnv(process.env.EVERDICT_EVENT_RETENTION_DAYS);
  if (eventRetentionDays !== undefined) {
    const sweepEvents = async (): Promise<void> => {
      const cutoff = new Date(Date.now() - eventRetentionDays * 24 * 3_600_000).toISOString();
      const removed = await platformEventStore.deleteOlderThan(cutoff).catch(() => 0);
      if (removed > 0) console.log(`▶ event-log retention: removed ${removed} facts older than ${cutoff}`);
    };
    setInterval(() => void sweepEvents(), 3_600_000).unref(); // atomic bulk delete, same as the trajectory twin
  }
  // Capture a session login into a profile (browser-profiles S3) — only when interactive sessions exist (it needs
  // a session's reachable CDP base). Encrypts the storageState blob with the shared at-rest cipher.
  const browserProfileCaptureService = browserSessionService
    ? new BrowserProfileCaptureService({
        store: browserProfileStore,
        resolveCdpBase: (sessionId, subject) => browserSessionService.cdpBaseFor(sessionId, subject),
        cipher,
      })
    : undefined;
  // Knowledge extraction — mine a discussion thread for proposed entries (the accumulation loop's extraction leg).
  // Same model plumbing as skill-generate: registered model + workspace/personal key, provider-native completion.
  const knowledgeExtraction = new KnowledgeExtractionService({
    models: modelRegistry,
    scopedSecretsFor,
    entries: knowledgeEntryService,
    comments: commentStore,
    ...(process.env.EVERDICT_JUDGE_OPENAI_BASE_URL
      ? { openaiBaseUrl: process.env.EVERDICT_JUDGE_OPENAI_BASE_URL }
      : {}),
  });

  // Capability Store — one discriminated versioned entity (mcp|code|skill|environment) members author, publish
  // (private|workspace|subset|public), and adopt into their agent (tool kinds) or consume at harness-authoring time
  // (environment). Reach beyond the workspace: subset fans across the author's own workspaces, public exposes to
  // everyone (admin-gated). Environment publishes classify their image against the workspace's registries
  // (warn-not-block). See docs/architecture/capability-store.md + docs/architecture/environment-image-store.md.
  // Hoisted out of the deps literal because the skill library reads it: taking a store skill = copying it in.
  const capabilityService = new CapabilityService({
    store: capabilityStore,
    registryCoordinates: (workspace) => imageRegistryService.coordinates(workspace),
    managedCoordinates,
    allowMemberPublicPublish,
    // Everdict's own entries, all three kinds: the default tools, the catalog-only servers, and the SKILL EXAMPLES —
    // examples are catalog entries a workspace copies into its library, never attachments (firstPartySkillExamples).
    firstPartyCatalog: () => [...firstPartyDefaults().map((d) => d.record), ...firstPartyCatalogExtras()],
  });

  // Workspace environment-image adoption (import) — inventory of adopted environments + pull-usability verification
  // (warn-not-block). Composes the capability store (resolve + visibility) + image registry (pull auth + verify).
  // Hoisted out of the deps literal because it closes the M6 cycle: its inventory IS the cross-tenant reach answer.
  const environmentAdoptionService = new EnvironmentAdoptionService({
    settings: settingsStore,
    capabilityStore,
    verifyImage: (ws, ref) => imageRegistryService.verifyImage(ws, ref),
    registryCoordinates: (ws) => imageRegistryService.coordinates(ws),
    managedCoordinates,
  });
  // Close the cycle: a ref in another workspace's namespace is pullable exactly when this workspace has adopted an
  // environment that declares it AND that capability is still consumable (re-checked on every read).
  imageReach.resolve = adoptedImageReach({ list: (ws, subject) => environmentAdoptionService.list(ws, subject) });
  // A mirror from a PRIVATE source authenticates with the registry credentials the workspace registered.
  sourcePullAuths.resolve = (tenant) => imageRegistryService.pullAuths(tenant);

  // Sandbox session runs (execution-model P6) — opt-in where the api can reach a container runtime
  // (EVERDICT_SANDBOX_DRIVER=docker). Facts + trajectory ride the same stores as every run; the interval is
  // the in-process TTL reaper half (the durable reaper rung survives a process death). Sits BELOW the
  // capability service because agent worlds (W1) publish snapshots through it.
  const sandboxSessions = buildSandboxSessions({
    store,
    trajectories: trajectoryStore,
    events: lateEvents,
    capabilities: capabilityStore,
    // The playground (harness-target sessions): registry + secrets + model binding + budget/usage — the
    // same resolution and billing lanes a dispatched run uses, applied to the driver lane.
    harnesses: harnessInstanceRegistry,
    models: modelRegistry,
    scopedSecretsFor,
    budget,
    usage: usageMeter,
    // P4 §5.1's causal leg, on this lane too: a session an AGENT opens draws from that turn's delegated
    // envelope and answers the depth / in-flight guards, instead of holding a container against nobody.
    envelopes: envelopeStore,
    // Agent worlds (W1): snapshots publish into the managed store and register as environment-capability
    // versions — absent managed store = world sessions 400, everything else keeps working. The pull side is
    // the dispatch lane's own credential seam: booting a world snapshot means pulling from our registry.
    ...(workspaceImages ? { images: workspaceImages } : {}),
    // W4: the placement-independent snapshot — publish the captured work tree as a layer through the
    // registry API, for a session whose container this control plane cannot reach a daemon for.
    ...(publishLayerSnapshot ? { publishLayerSnapshot } : {}),
    capabilityService,
    registryAuthsFor,
    // W2: git in and out of a session — the workspace App resolves a read credential for a clone and mints a
    // write one per push. Absent install = public clones only, pushing 404s with the repo named.
    ...(githubAppService ? { githubApp: githubAppService } : {}),
    // W4: a cluster-placed session is isolated by the same policy a dispatched case is, and a workspace can
    // place one on ITS OWN registered runtime rather than borrowing the deployment's compute.
    ...(trustZones ? { trustZones } : {}),
    // Front-door conversations: a kind:"service" harness session drives its warm topology on a REGISTERED
    // workspace runtime, through the SAME shared topology environment the eval lane dispatches with.
    topologyConversationEnvironmentFor,
    // W5: compute comes from the one resolver — the eval lane's OWN nomad where one is registered (so the
    // cluster has one owner, one credential, one capacity envelope that counts held-open sessions), and the
    // workspace's registered runtimes on the same axis a run's placement.target names.
    compute: runtimeCompute,
    ...(compute ? { deployment: compute } : {}),
    // T-b: the durable reaper rides the same Temporal driver as approvals — a CP dying with the live
    // handle no longer leaks the container or the row. extend re-arms the deadline on touch (W1).
    ...(approvalTemporal
      ? {
          reaper: {
            start: (input: { runId: string; tenant: string; expiresAt: string }) => approvalTemporal.startReaper(input),
            signalClosed: (runId: string) => approvalTemporal.signalReaperClosed(runId),
            extend: (input: { runId: string; tenant: string; expiresAt: string }) =>
              approvalTemporal.extendReaper(input),
          },
        }
      : {}),
  });
  if (sandboxSessions) {
    // Per-replica by nature (like the browser twin): this reaps the compute THIS process holds open.
    setInterval(() => sandboxSessions.sweep(), 30_000).unref();
    // The ledger half of the sweep: reap rows whose deadline passed with no live handle anywhere — the
    // safety net for a durable reaper that never armed or a process that died holding the session. Leader-gated:
    // it reaches rows other replicas wrote (ORPHAN_GRACE_MS is the second guard, not the only one).
    setInterval(
      whenLeader(leader, () => void sandboxSessions.sweepOrphans().catch(() => {})),
      60_000,
    ).unref();
    if (leader.isLeader()) void sandboxSessions.sweepOrphans().catch(() => {}); // boot pass — reclaim what the LAST process leaked
  }
  // Session rows whose lane is NOT configured here still share this ledger (another process — a dev host
  // stack, a dead replica — may have written and abandoned them). Settle those from the ledger alone; lanes
  // configured above exclude their trigger because their own sweep owns the full container teardown.
  {
    const excludeTriggers = [...(sandboxSessions ? ["sandbox"] : []), ...(browserSessionService ? ["browser"] : [])];
    // Leader-gated: every row it settles belongs to some other process, and each settle emits a fact.
    const sweepUnowned = whenLeader(leader, () => {
      void settleOrphanSessionRuns({ store, events: lateEvents, excludeTriggers }).catch(() => {});
    });
    setInterval(sweepUnowned, 60_000).unref();
    sweepUnowned(); // boot pass
  }

  const app = buildServer({
    terminalTickets,
    screenTickets,
    ...(browserSessionService && browserTickets ? { browserSessionService, browserTickets } : {}),
    ...(sandboxSessions ? { sandboxSessions } : {}), // sandbox session runs (P6) — routes/tools absent without a driver
    trajectoryStore, // the owned evidence ledger's browse surface (N1 look-inward): GET /trajectories + list_trajectories
    browserProfileService, // saved authenticated browser profiles (browser-profiles S2) — workspace-scoped metadata CRUD
    ...(browserProfileCaptureService ? { browserProfileCaptureService } : {}), // S3 capture (needs browser sessions)
    proxyService, // workspace BYO egress proxies (browser-profiles S4) — per-country pool + session geo
    liveFrames, // live-screen frames pushed by self-hosted runners (report_case_screen MCP tool)
    liveLogs, // live execution log pushed by self-hosted runners (report_case_log MCP tool)
    liveTraces, // live trajectory per run (dispatch marks + report_case_trace) — served by /runs/:id/trajectory/live
    ...(caseRecorder ? { caseRecorder } : {}), // durable replay tee (opt-in) for the pushed frames/logs
    caseFsRequests, // run-workbench fs rendezvous (self-hosted lane) — the lease tools drain/answer it
    service,
    scorecardService,
    // Driver ops surface v0 (docs/orchestration.md) — present only when Temporal is configured; reads/controls
    // the durable driver (batch/score workflows) by ledger id, through the everdict wrap only.
    ...(process.env.EVERDICT_TEMPORAL_ADDRESS
      ? { driverOps: new DriverOpsService({ address: process.env.EVERDICT_TEMPORAL_ADDRESS }) }
      : {}),
    approvalService, // durable agent approvals (A6) — members list/decide; the agent service parks/settles
    // The OTLP/HTTP door (N0) — traces seal in the owned store; the N3 admission lane refuses past the
    // events/hour quota (workspace override, else EVERDICT_INGEST_MAX_EVENTS_PER_HOUR) at 429, never silently.
    otlpIngest: new OtlpIngestService(trajectoryStore, {
      quotaFor: async (tenant) => (await settingsStore.get(tenant))?.traceIngestion,
      ...(positiveIntEnv(process.env.EVERDICT_INGEST_MAX_EVENTS_PER_HOUR) !== undefined
        ? { defaultMaxEventsPerHour: positiveIntEnv(process.env.EVERDICT_INGEST_MAX_EVENTS_PER_HOUR) }
        : {}),
      events: platformEventService,
    }),
    traceIngestionConfig: {
      ...(positiveIntEnv(process.env.EVERDICT_INGEST_MAX_EVENTS_PER_HOUR) !== undefined
        ? { defaultMaxEventsPerHour: positiveIntEnv(process.env.EVERDICT_INGEST_MAX_EVENTS_PER_HOUR) }
        : {}),
      ...(positiveIntEnv(process.env.EVERDICT_TRAJECTORY_RETENTION_DAYS) !== undefined
        ? { retentionDays: positiveIntEnv(process.env.EVERDICT_TRAJECTORY_RETENTION_DAYS) }
        : {}),
    },
    metrics, // GET /metrics (Prometheus text) — unauthenticated; deployments firewall the scrape path
    schedulingControl, // PUT/GET /internal/scheduling — runtime fairness dials (env stays the boot baseline)
    usageMeter, // meter-only billing usage — GET /usage
    budget, // enforcement budget config — GET/PUT /budget (usage + per-tenant limit)
    settleBudget: (tenant, cost) => budget.settle(tenant, cost), // internal usage bridge → the 402-cap total (agent cost)
    scheduleService,
    queueService,
    viewService,
    checkpointService,
    taskService,
    teamService,
    workflowStateService, // the team's board — /teams/:id/states, edited from Settings › Teams
    issueService,
    issueLabelService,
    issueSync: githubIssueSync,
    cycleService, // the team's iterations — /cycles
    projectService,
    initiativeService,
    productService,
    productVersionSync,
    productDiscovery,
    workspacePulseService,
    subscriptionService,
    // §5.1 activation admission — the agent service asks this before launching a run (402 past the tenant
    // budget; a pass reserves one run, settled later via the usage bridge below).
    admitActivation: (tenant: string) => budget.admit(tenant),
    // T-d bridge (activity → CP → agent service): mirror the agent service's answer so the workflow's retry
    // semantics ride HTTP honestly (503 = retry later; 200 {skipped}/{sessionId} = the workflow decides).
    ...(approvalAgentUrl && approvalAgentToken
      ? {
          reactionBridge: {
            start: async (input: {
              workspace: string;
              agentId: string;
              eventId: string;
              subscriptionId: string;
              eventKind: string;
              message: string;
              payload?: Record<string, unknown>;
              subject?: { type: string; id: string };
              instruction?: string;
            }) => {
              const res = await fetch(new URL("/internal/activations", approvalAgentUrl), {
                method: "POST",
                headers: { "content-type": "application/json", "x-internal-token": approvalAgentToken },
                body: JSON.stringify(input),
              });
              return { status: res.status, body: await res.json().catch(() => ({})) };
            },
            status: async (workspace: string, sessionId: string) => {
              const url = new URL(`/internal/activations/${encodeURIComponent(sessionId)}/status`, approvalAgentUrl);
              url.searchParams.set("workspace", workspace);
              const res = await fetch(url, { headers: { "x-internal-token": approvalAgentToken } });
              return { status: res.status, body: await res.json().catch(() => ({})) };
            },
          },
        }
      : {}),
    viewSnapshotService,
    benchmarkService,
    bundleService,
    harnessTemplates: harnessTemplateRegistry,
    harnessInstances: harnessInstanceRegistry,
    datasetRegistry,
    judgeRegistry,
    judgePreviewService: new JudgePreviewService({
      rubrics: rubricRegistry,
      judgeRunner,
      submitCodeJudgeRun, // code dry-run = a real standalone run (trigger "judge-preview") — watchable on the run surfaces
      getRun: async (tenant, runId) => {
        const rec = await service.get(runId);
        return rec?.tenant === tenant ? rec : undefined; // workspace-scope the re-score
      },
    }),
    rubricRegistry,
    modelRegistry,
    // Model connection test (dummy completion) + version-free save/edit upsert. Reuses the same secret tiers (scopedSecretsFor)
    // and OpenAI base default (LiteLLM etc.) the judge runner uses, so a probe reflects exactly what a real dispatch resolves.
    modelService: new ModelService({
      models: modelRegistry,
      scopedSecretsFor,
      ...(process.env.EVERDICT_JUDGE_OPENAI_BASE_URL
        ? { openaiBaseUrl: process.env.EVERDICT_JUDGE_OPENAI_BASE_URL }
        : {}),
    }),
    agentRegistry,
    // Agent config version-free save/edit upsert (the interactive web path) — the workspace's conversational-agent customization.
    agentService: new AgentService({ agents: agentRegistry }),
    // Shadow try-drive relay (`try_agent` MCP tool → agent service /internal/try) — the self-evolution loop's
    // evaluate step. A refused relay throws rather than shaping a fake result: "the runtime said no" and "the
    // try produced nothing" are different facts.
    ...(approvalAgentUrl && approvalAgentToken
      ? {
          agentTry: (async (input) => {
            const res = await fetch(new URL("/internal/try", approvalAgentUrl), {
              method: "POST",
              headers: { "content-type": "application/json", "x-internal-token": approvalAgentToken },
              body: JSON.stringify(input),
            }).catch((err: unknown) => {
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                {},
                `the agent runtime could not be reached: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
            if (!res.ok)
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { status: res.status },
                `the agent runtime refused the try (${res.status}).`,
              );
            return res.json();
          }) satisfies AgentTryRelay,
        }
      : {}),
    // Settings › Agent › Tools + › Skills — the CALLER's own agent: the workspace baseline (AgentSpec + the authored
    // skill library) overlaid with that member's on/off. This is what keeps one workspace from meaning one agent
    // (see agent-member-tooling-service.ts).
    agentMemberToolingService: new AgentMemberToolingService({
      agents: agentRegistry,
      capabilities: capabilityStore,
      preferences: agentMemberPreferenceStore,
      skills: skillStore,
      secrets: secretStore,
      settings: settingsStore,
      // The tool DETAIL surface needs two things the list never did: a live MCP connect (what functions does this
      // really serve) and the AgentSpec upsert (rebinding a tool's secret is an agent-config edit).
      agentService: new AgentService({ agents: agentRegistry }),
      probeMcp: probeMcpServer,
      // A member's own default model is validated against the registered models — the same registry the agent server
      // resolves the pick through at turn time.
      models: modelRegistry,
    }),
    // Workspace Skills — SKILL.md procedures the members author (dual-scoped private|workspace) + skill-generate (drafts
    // a skill from a description via the workspace's registered model + key; same secret tiers/base as the model probe).
    skillService: new SkillService({
      store: skillStore,
      latestVersionOf,
      fs: workspaceFs,
      versions: skillVersionStore, // the stamped version line ("edit it in conversation, then name the version")
      capabilities: capabilityService, // taking a store example = copying it into this library
    }),
    // The workspace filesystem — the shared, workspace-isolated file tree (web Files page + list_files/get_file/
    // write_file MCP tools; agents persist task outputs here as real files). Backed by S3/MinIO when env-configured.
    fsService: new FsService(workspaceFs, fsRevisionStore),
    // "Run" for a workspace file — a sandbox per run, disposed after it. Opt-in: absent unless the deployment
    // gave the control plane a container runtime (EVERDICT_FILE_EXECUTION_DRIVER=docker).
    fileExecutionService: buildFileExecutionService(workspaceFs, runtimeCompute, compute, {
      runs: store,
      ...(lateEvents ? { events: lateEvents } : {}),
      // The singular gate reaches this lane too: the tenant's budget, and — when an agent asked — its
      // causer's envelope plus the depth / in-flight guards. It used to have no admission at all.
      budget,
      envelopes: envelopeStore,
    }),
    capabilityService,
    // Instance policy surfaced to the web (GET /me → config): does a plain member — not only an admin — get to
    // publish a capability to the instance-wide `public` catalog? Operator opt-in for a community-style deployment.
    allowMemberPublicPublish,
    // Capability wizard "test connection" for the mcp kind — connect to an MCP URL and enumerate its tools.
    probeCapabilityMcp: probeMcpServer,
    skillGenerator: new SkillGenerator({
      models: modelRegistry,
      scopedSecretsFor,
      ...(process.env.EVERDICT_JUDGE_OPENAI_BASE_URL
        ? { openaiBaseUrl: process.env.EVERDICT_JUDGE_OPENAI_BASE_URL }
        : {}),
    }),
    runtimeRegistry,
    probeRuntime,
    inspectRuntime,
    controlRuntime,
    settingsStore,
    workspaceStore,
    workspaceService,
    membershipService,
    profileService,
    secretStore,
    secretUsageService,
    invalidateTenantBackends, // workspace secret change → drop the tenant's cached runtime backends (stale secretEnv)
    githubAppService,
    mattermostService,
    mattermostCommandService,
    traceSourceService,
    spanAttrMappingService,
    imageRegistryService,
    imageTokenService,
    ...(workspaceImages ? { images: workspaceImages } : {}),
    // Copy an image into the managed registry — a workspace's namespace, or the platform's (internal route).
    ...(imageMirror ? { imageMirror } : {}),
    environmentAdoptionService,
    ciLinkService,
    runnerService,
    notificationService, // notification feed (bell inbox) route — self-scoped
    platformEvents: platformEventService, // platform-event log — internal reconcile cursor (agent-automation A1)
    commentService, // resource comments route + MCP
    knowledgeService, // workspace knowledge graph route + MCP
    knowledgeEntryService, // knowledge entries (reified claims) CRUD + verify — route + MCP
    knowledgeExtraction, // thread → proposed-entry mining — route + MCP
    runnerHub,
    authenticator: buildAuthenticator(keyStore, runnerStore, settingsStore),
    keyStore,
    internalToken: process.env.EVERDICT_INTERNAL_TOKEN,
    metricsToken: process.env.EVERDICT_METRICS_TOKEN,
    requireAuth: process.env.EVERDICT_REQUIRE_AUTH === "1",
    ...(callbackRendezvous ? { callbackSink: callbackRendezvous } : {}), // receive /frontdoor-callback inbound (the same rendezvous instance)
    // Structured request/auth logs (pino). Default info — diagnose auth denials (401) and their reason from the control-plane log. Turn off with silent.
    logLevel: process.env.EVERDICT_LOG_LEVEL ?? "info",
    // MCP OAuth: advertise Keycloak as the authorization server (the client starts login). Unset → API keys only.
    ...(process.env.KEYCLOAK_ISSUER ? { authorizationServers: [process.env.KEYCLOAK_ISSUER] } : {}),
  });

  // Hand the leader lease back on a normal shutdown, so a rolling restart's next replica takes over at once
  // instead of waiting out the lease TTL. Without a leader (single process) this is a no-op.
  const shutdown = (signal: string): void => {
    // Stop counting as alive too: whoever boots next should reclaim this replica's interrupted work at once
    // rather than waiting for our heartbeat to go stale.
    void Promise.allSettled([leader.stop(), replicas.leave()]).finally(() => process.exit(0));
    console.error(`▶ ${signal}: control plane shutting down`);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ port, host: "0.0.0.0" });
  console.error(
    `▶ everdict-api on :${port} (backend:${nomad ? "nomad" : k8sContext ? "k8s" : "runtime-only"} store:${process.env.DATABASE_URL ? "postgres" : "memory"} auth:${process.env.EVERDICT_REQUIRE_AUTH === "1" ? "required" : "dev-fallback"} runtime:required)`,
  );
}

main().catch((err) => {
  console.error("everdict-api failed to start:", err);
  process.exit(1);
});

// Node's DNS lookup as a promise — the resolver the run-webhook SSRF check judges.
const lookupDns = promisify(lookupDnsCb);
