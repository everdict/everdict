import {
  GithubIssueSync,
  InitiativeService,
  IssueLabelService,
  IssueService,
  KnowledgeEntryService,
  KnowledgeService,
  ProjectService,
  TaskService,
  TeamService,
  registryLatestVersionResolver,
  seedFirstPartyAgents,
} from "@everdict/application-control";
import { ApprovalService } from "@everdict/application-control";
import {
  EventConsumerRunner,
  mattermostConsumer,
  regressionWatch,
  runFeedConsumer,
  scorecardFeedConsumer,
  subscriptionReactionConsumer,
} from "@everdict/application-control";
import { ProxyService } from "@everdict/application-control";
import {
  FsService,
  RevisionedWorkspaceFs,
  SkillService,
  withRegisteredFact,
  withTracePerception,
} from "@everdict/application-control";
import {
  CapabilityService,
  EnvironmentAdoptionService,
  adoptedImageReach,
  firstPartyCatalogExtras,
  firstPartyDefaults,
} from "@everdict/application-control";
import { perTenantTrustZones } from "@everdict/domain";
import { InMemoryWorkspaceFs } from "@everdict/storage";
import type { BrowserSessionProvisioner } from "./common/browser-session-provisioner.js";
import { CaseRecorder } from "./common/case-recorder.js";
import { LiveFrameStore } from "./common/live-frame-store.js";
import { LiveLogStore } from "./common/live-log-store.js";
import { TerminalTicketStore } from "./common/terminal-ticket.js";
import { TicketStore } from "./common/ticket-store.js";
import { buildAuthenticator } from "./composition/authenticator.js";
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
import { lateBoundEmitter } from "./composition/late-events.js";
import { makePersistence } from "./composition/persistence.js";
import { buildRun } from "./composition/run.js";
import { buildRuntimeAccess, runStartupRecovery } from "./composition/runtime-access.js";
import { buildSandboxSessions } from "./composition/sandbox.js";
import { ScheduleServiceRef, wireScheduleService } from "./composition/schedule.js";
import { buildScorecard } from "./composition/scorecard.js";
import {
  buildBrowserProfile,
  buildCatalog,
  buildCiLink,
  buildMattermostCommand,
  buildQueue,
  buildSubscription,
  buildView,
  buildViewSnapshot,
} from "./composition/services.js";
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
import { DockerBrowserProvisioner } from "./infrastructure/browser-session/docker-browser-provisioner.js";
import { LocalChromeProvisioner } from "./infrastructure/browser-session/local-chrome-provisioner.js";
import { runtimeSessionProvision } from "./infrastructure/browser-session/nomad-session-provision.js";
import { PooledBrowserProvisioner } from "./infrastructure/browser-session/pooled-browser-provisioner.js";
import { RoutingBrowserProvisioner } from "./infrastructure/browser-session/routing-browser-provisioner.js";
import { RuntimeBrowserProvisioner } from "./infrastructure/browser-session/runtime-browser-provisioner.js";
import { githubRepoWriterFactory } from "./infrastructure/github/repo-writer.js";
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
  const nomadAddr = process.env.NOMAD_ADDR;
  const k8sContext = process.env.EVERDICT_K8S_CONTEXT;
  const image = process.env.EVERDICT_AGENT_IMAGE;

  const {
    store,
    recordingStore,
    scorecardStore,
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
    taskStore,
    teamStore,
    issueStore,
    issueLabelStore,
    projectStore,
    initiativeStore,
    browserProfileStore,
    skillStore,
    skillVersionStore,
    capabilityStore,
    agentMemberPreferenceStore,
    callbackStore,
    usageStore,
    budgetStore,
    cipher,
  } = await makePersistence();

  // E2 content/registry facts (event-plumbing.md §3): registration is a state transition, so it emits its fact.
  // Decorated ONCE here — every caller (routes, MCP tools, bundle apply, benchmark import, CI re-pin) goes
  // through the same decorated instance; _shared seeds never emit. The platform-event service is built later
  // (buildIntegrations), so the decorators emit through a late-bound forwarder connected below.
  const lateEvents = lateBoundEmitter();
  const harnessInstanceRegistry = withRegisteredFact(
    rawHarnessInstanceRegistry,
    "harness.registered",
    "harness",
    lateEvents,
  );
  const datasetRegistry = withRegisteredFact(rawDatasetRegistry, "dataset.registered", "dataset", lateEvents);
  const judgeRegistry = withRegisteredFact(rawJudgeRegistry, "judge.registered", "judge", lateEvents);
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
  // tenant-listable record stores (scorecards/runs/schedules) into it, plus task-time context assembly over the
  // knowledge-layer records (skills + entries). See docs/architecture/knowledge-graph.md.
  const knowledgeService = new KnowledgeService({
    store: knowledgeStore,
    reindexSources: {
      scorecards: scorecardStore,
      runs: store,
      schedules: scheduleStore,
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

  const { backends, scheduler, schedulingControl, autoscale, scalingTargets, tenantQuotas } = buildExecutionScheduling({
    nomadAddr,
    k8sContext,
    image,
    secretStore,
  });
  // M2 — runtime.circuit_opened rides the breaker's own closed→open transition (late-bound: the platform event
  // service is built after the scheduler). Key format is `${tenant}:${runtimeId}` — split on the FIRST colon
  // (the runtime half may itself carry colons, e.g. self:ws).
  const { metrics, breaker } = buildObservability(scheduler, {
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
  startAutoscaler({ autoscale, scalingTargets, scheduler });
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

  // Managed image store (optional) — the workspace's own image namespace + the registry's authorization server.
  // Unset env = a BYO-only deployment: both stay undefined and /v2/token answers 404.
  // Cross-tenant pull reach (M6) is bound AFTER the adoption service exists: the store needs reach, and reach
  // needs the store's coordinates to classify an image. The cycle is real, so the predicate is a thunk over a
  // holder the adoption wiring fills in — until then it denies, which is the same answer as running without M6.
  const imageReach: { resolve?: (tenant: string, ref: string) => Promise<boolean> } = {};
  const { images: workspaceImages, imageTokenService } = buildManagedImages(process.env, {
    crossTenantPull: (tenant, ref) => (imageReach.resolve ? imageReach.resolve(tenant, ref) : Promise.resolve(false)),
  });
  // The workspace's coordinates in that store — what makes classifyImageRef able to answer "managed". One
  // definition, handed to every surface that classifies, so the store and the inventory never disagree.
  const managedCoordinates = (workspace: string) =>
    workspaceImages
      ? { host: workspaceImages.endpoint, namespace: workspaceImages.namespaceFor(workspace) }
      : undefined;

  const {
    runnerHub,
    callbackRendezvous,
    runtimeSecretsFor,
    scopedSecretsFor,
    imageRegistryService,
    registryAuthsFor,
    runtimeBuildBackend,
    dispatcher,
    meteredDispatcher,
    probeRuntime,
    inspectRuntime,
    controlRuntime,
    invalidateTenantBackends,
    releaseSelfRunnerBackend,
  } = buildDispatch({
    ...(workspaceImages ? { images: workspaceImages } : {}),
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
  setInterval(() => void commentService.sweepStuckAgentAnswers(15 * 60_000).catch(() => {}), 60_000).unref();

  // Per-runtime backend access for already-dispatched cases (adoption/kill + live-observability lane reads). Built
  // before run/scorecard because their live-observability + supersede-kill wiring closes over these functions.
  const {
    adoptCaseFn,
    readCaseLogsFn,
    openTerminalStreamFn,
    captureBrowserScreenFn,
    screenEndpointFn,
    execInSandboxFn,
    inspectCasePlacementFn,
    inspectTopologyFn,
    topologyServiceLogsFn,
    killCase,
  } = buildRuntimeAccess({ runtimeRegistry, runtimeSecretsFor, runtimeBuildBackend });

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
  // Cascade cancel (§5.5 O8) — late-bound: the scorecard service is built after the run service, so the
  // hook resolves through this holder (fires only at runtime, long after boot completes).
  const cascadeCancel: { fn?: (tenant: string, runId: string) => Promise<number> } = {};
  const { service, judgeRunner, submitCodeJudgeRun } = buildRun({
    envelopes: envelopeStore,
    trajectories: trajectoryStore,
    onAgentRunCancelled: async (tenant, runId) => cascadeCancel.fn?.(tenant, runId),
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
    readers: {
      readCaseLogsFn,
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
    ...(recordingStore ? { recordingStore } : {}),
  });

  const scorecardService = buildScorecard({
    envelopes: envelopeStore,
    trajectories: trajectoryStore,
    scorecardStore,
    runStore: store,
    ...(recordingStore ? { recordingStore } : {}),
    meteredDispatcher,
    scheduler,
    runnerHub,
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
    registryAuthsFor,
    notificationService,
    platformEventService,
    traceSinkService,
    preflightPlacement,
    killCase,
    adoptCaseFn,
  });
  cascadeCancel.fn = (tenant, runId) => scorecardService.cancelCausedBy(tenant, runId);

  await runStartupRecovery({ scorecardStore, store, scorecardService, service, adoptCaseFn });

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
  const teamService = new TeamService({
    store: teamStore,
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
    events: platformEventService,
    github: { pushStatus: async (record, actor) => githubSyncRef.current?.pushStatus(record, actor) },
  });
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
      scorecards: scorecardStore,
      feed: notificationStore,
    }),
  );
  const projectService = new ProjectService({
    store: projectStore,
    issues: issueStore,
    events: platformEventService,
  });
  const initiativeService = new InitiativeService({
    store: initiativeStore,
    projects: projectStore,
    issues: issueStore,
    events: platformEventService,
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
  const sessionTrustZones = perTenantTrustZones();
  const runtimeBrowserProvisioner = new RuntimeBrowserProvisioner({
    resolveSpec: (tenant, id) => runtimeRegistry.get(tenant, id).catch(() => undefined),
    zoneFor: (tenant) => sessionTrustZones.resolve(tenant),
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
        ...(browserMaxPerTenant !== undefined ? { maxPerTenant: browserMaxPerTenant } : {}),
        ...(browserMaxTotal !== undefined ? { maxTotal: browserMaxTotal } : {}),
      })
    : undefined;
  if (browserSessionService) setInterval(() => browserSessionService.sweep(), 60_000).unref(); // TTL teardown
  // Sandbox session runs (execution-model P6) — opt-in where the api can reach a container runtime
  // (EVERDICT_SANDBOX_DRIVER=docker). Facts + trajectory ride the same stores as every run; the interval is
  // the in-process TTL reaper half (the durable reaper rung survives a process death).
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
    // T-b: the durable reaper rides the same Temporal driver as approvals — a CP dying with the live
    // handle no longer leaks the container or the row.
    ...(approvalTemporal
      ? {
          reaper: {
            start: (input: { runId: string; tenant: string; expiresAt: string }) => approvalTemporal.startReaper(input),
            signalClosed: (runId: string) => approvalTemporal.signalReaperClosed(runId),
          },
        }
      : {}),
  });
  if (sandboxSessions) setInterval(() => sandboxSessions.sweep(), 30_000).unref();
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
    setInterval(() => void sweepEvents(), 3_600_000).unref();
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
    ...(caseRecorder ? { caseRecorder } : {}), // durable replay tee (opt-in) for the pushed frames/logs
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
    taskService,
    teamService,
    issueService,
    issueLabelService,
    issueSync: githubIssueSync,
    projectService,
    initiativeService,
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
    fileExecutionService: buildFileExecutionService(workspaceFs),
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
    requireAuth: process.env.EVERDICT_REQUIRE_AUTH === "1",
    ...(callbackRendezvous ? { callbackSink: callbackRendezvous } : {}), // receive /frontdoor-callback inbound (the same rendezvous instance)
    // Structured request/auth logs (pino). Default info — diagnose auth denials (401) and their reason from the control-plane log. Turn off with silent.
    logLevel: process.env.EVERDICT_LOG_LEVEL ?? "info",
    // MCP OAuth: advertise Keycloak as the authorization server (the client starts login). Unset → API keys only.
    ...(process.env.KEYCLOAK_ISSUER ? { authorizationServers: [process.env.KEYCLOAK_ISSUER] } : {}),
  });

  await app.listen({ port, host: "0.0.0.0" });
  console.error(
    `▶ everdict-api on :${port} (backend:${nomadAddr ? "nomad" : k8sContext ? "k8s" : "runtime-only"} store:${process.env.DATABASE_URL ? "postgres" : "memory"} auth:${process.env.EVERDICT_REQUIRE_AUTH === "1" ? "required" : "dev-fallback"} runtime:required)`,
  );
}

main().catch((err) => {
  console.error("everdict-api failed to start:", err);
  process.exit(1);
});
