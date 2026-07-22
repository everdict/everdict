import { ProxyService } from "@everdict/application-control";
import { InMemoryRecordingStore } from "@everdict/db";
import { perTenantTrustZones } from "@everdict/domain";
import type { BrowserSessionProvisioner } from "./common/browser-session-provisioner.js";
import { CaseRecorder } from "./common/case-recorder.js";
import { LiveFrameStore } from "./common/live-frame-store.js";
import { LiveLogStore } from "./common/live-log-store.js";
import { TerminalTicketStore } from "./common/terminal-ticket.js";
import { TicketStore } from "./common/ticket-store.js";
import { buildAuthenticator } from "./composition/authenticator.js";
import { buildDispatch } from "./composition/dispatch.js";
import { artifactStoreFromEnv, meterUsagePolicyFromEnv } from "./composition/env-policy.js";
import {
  buildBudgets,
  buildExecutionScheduling,
  buildObservability,
  startAutoscaler,
} from "./composition/execution-scheduling.js";
import { buildIntegrations } from "./composition/integrations.js";
import { makePersistence } from "./composition/persistence.js";
import { buildRun } from "./composition/run.js";
import { buildRuntimeAccess, runStartupRecovery } from "./composition/runtime-access.js";
import { ScheduleServiceRef, wireScheduleService } from "./composition/schedule.js";
import { buildScorecard } from "./composition/scorecard.js";
import {
  buildBrowserProfile,
  buildCatalog,
  buildCiLink,
  buildMattermostCommand,
  buildQueue,
  buildView,
} from "./composition/services.js";
import { buildWorkspace } from "./composition/workspace.js";
import { BrowserProfileCaptureService } from "./core/browser-profile/browser-profile-capture-service.js";
import { BrowserSessionService } from "./core/browser-session/browser-session-service.js";
import { buildPlacementPreflight } from "./core/execution/placement-preflight.js";
import { JudgePreviewService } from "./core/judge/judge-preview-service.js";
import { ModelService } from "./core/model/model-service.js";
import { SecretUsageService } from "./core/secret/secret-usage-service.js";
import { DockerBrowserProvisioner } from "./infrastructure/browser-session/docker-browser-provisioner.js";
import { LocalChromeProvisioner } from "./infrastructure/browser-session/local-chrome-provisioner.js";
import { runtimeSessionProvision } from "./infrastructure/browser-session/nomad-session-provision.js";
import { PooledBrowserProvisioner } from "./infrastructure/browser-session/pooled-browser-provisioner.js";
import { RoutingBrowserProvisioner } from "./infrastructure/browser-session/routing-browser-provisioner.js";
import { RuntimeBrowserProvisioner } from "./infrastructure/browser-session/runtime-browser-provisioner.js";
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
  const port = Number(process.env.PORT ?? "8787");
  const nomadAddr = process.env.NOMAD_ADDR;
  const k8sContext = process.env.EVERDICT_K8S_CONTEXT;
  const image = process.env.EVERDICT_AGENT_IMAGE;

  const {
    store,
    scorecardStore,
    keyStore,
    harnessTemplateRegistry,
    harnessInstanceRegistry,
    datasetRegistry,
    benchmarkRegistry,
    judgeRegistry,
    rubricRegistry,
    modelRegistry,
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
    commentStore,
    viewStore,
    browserProfileStore,
    callbackStore,
    usageStore,
    budgetStore,
    cipher,
  } = await makePersistence();

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
  const { metrics, breaker } = buildObservability(scheduler);
  startAutoscaler({ autoscale, scalingTargets, scheduler });
  const { budget, usageMeter } = await buildBudgets({ budgetStore, usageStore });

  const {
    runnerHub,
    callbackRendezvous,
    runtimeSecretsFor,
    scopedSecretsFor,
    imageRegistryService,
    runtimeBuildBackend,
    dispatcher,
    meteredDispatcher,
    probeRuntime,
    inspectRuntime,
    controlRuntime,
    invalidateTenantBackends,
    releaseSelfRunnerBackend,
  } = buildDispatch({
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
  });
  // Revoking a runner drops its lazily-registered self:<owner>:<runnerId> placement backend (runner churn hygiene —
  // built here because the dispatcher is created after the workspace/runner services).
  runnerService.onRevoke = (owner, id) => releaseSelfRunnerBackend(owner, id);

  // Artifact store (when env-configured): offload os-use screenshots to S3/MinIO → result records carry only a presigned URL (no base64 inline).
  // Unset → undefined → the service falls back to base64 inline (dev). Credentials are env secrets (never committed).
  const artifacts = await artifactStoreFromEnv();
  if (artifacts) console.log("▶ artifact store: S3/MinIO offload enabled (os-use screenshots)");

  const envMeterPolicy = meterUsagePolicyFromEnv(); // default policy when the workspace has no DB setting
  const {
    notificationService,
    mattermostService,
    traceSinkService,
    traceSourceService,
    spanAttrMappingService,
    commentService,
    githubAppService,
  } = buildIntegrations({
    settingsStore,
    notificationStore,
    commentStore,
    oauthStateStore,
    membershipService,
    runtimeSecretsFor,
  });

  // Per-runtime backend access for already-dispatched cases (adoption/kill + live-observability lane reads). Built
  // before run/scorecard because their live-observability + supersede-kill wiring closes over these functions.
  const { adoptCaseFn, readCaseLogsFn, openTerminalStreamFn, captureBrowserScreenFn, execInSandboxFn, killCase } =
    buildRuntimeAccess({ runtimeRegistry, runtimeSecretsFor, runtimeBuildBackend });

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
  // Durable replay recording (opt-in via EVERDICT_RECORDING) — the runner-lease MCP tees the pushed frames/logs here
  // so a run can be replayed after it settles; RunService seals it at finalize. In-memory for now (Pg + object-store
  // retention is S4); the frame offload needs an object store. docs/architecture/replay.md.
  const recordingStore = process.env.EVERDICT_RECORDING ? new InMemoryRecordingStore() : undefined;
  const caseRecorder = recordingStore && artifacts ? new CaseRecorder(recordingStore, artifacts) : undefined;
  const { service, judgeRunner, submitCodeJudgeRun } = buildRun({
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
    readers: { readCaseLogsFn, execInSandboxFn, captureBrowserScreenFn, openTerminalStreamFn },
    liveFrames,
    liveLogs,
    ...(recordingStore ? { recordingStore } : {}),
  });

  const scorecardService = buildScorecard({
    scorecardStore,
    runStore: store,
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
    imageRegistryService,
    notificationService,
    traceSinkService,
    preflightPlacement,
    killCase,
    adoptCaseFn,
  });

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
  const scheduleService = wireScheduleService(scheduleRef, { scheduleStore, scorecardService, notificationService });

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
  const browserSessionService = browserSessionsEnabled
    ? new BrowserSessionService(routingBrowserProvisioner, {
        resolveProxy: (ws, country) => proxyService.resolve(ws, country),
        ...(browserMaxPerTenant !== undefined ? { maxPerTenant: browserMaxPerTenant } : {}),
        ...(browserMaxTotal !== undefined ? { maxTotal: browserMaxTotal } : {}),
      })
    : undefined;
  if (browserSessionService) setInterval(() => browserSessionService.sweep(), 60_000).unref(); // TTL teardown
  // Capture a session login into a profile (browser-profiles S3) — only when interactive sessions exist (it needs
  // a session's reachable CDP base). Encrypts the storageState blob with the shared at-rest cipher.
  const browserProfileCaptureService = browserSessionService
    ? new BrowserProfileCaptureService({ store: browserProfileStore, sessions: browserSessionService, cipher })
    : undefined;
  const app = buildServer({
    terminalTickets,
    ...(browserSessionService && browserTickets ? { browserSessionService, browserTickets } : {}),
    browserProfileService, // saved authenticated browser profiles (browser-profiles S2) — personal metadata CRUD
    ...(browserProfileCaptureService ? { browserProfileCaptureService } : {}), // S3 capture (needs browser sessions)
    proxyService, // workspace BYO egress proxies (browser-profiles S4) — per-country pool + session geo
    liveFrames, // live-screen frames pushed by self-hosted runners (report_case_screen MCP tool)
    liveLogs, // live execution log pushed by self-hosted runners (report_case_log MCP tool)
    ...(caseRecorder ? { caseRecorder } : {}), // durable replay tee (opt-in) for the pushed frames/logs
    service,
    scorecardService,
    metrics, // GET /metrics (Prometheus text) — unauthenticated; deployments firewall the scrape path
    schedulingControl, // PUT/GET /internal/scheduling — runtime fairness dials (env stays the boot baseline)
    usageMeter, // meter-only billing usage — GET /usage
    budget, // enforcement budget config — GET/PUT /budget (usage + per-tenant limit)
    scheduleService,
    queueService,
    viewService,
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
    ciLinkService,
    runnerService,
    notificationService, // notification feed (bell inbox) route — self-scoped
    commentService, // resource comments route + MCP
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
