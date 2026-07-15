import { LiveFrameStore } from "./common/live-frame-store.js";
import { TerminalTicketStore } from "./common/terminal-ticket.js";
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
  seedSharedHarnessTaxonomy,
  seedSharedJudges,
  seedSharedModels,
  seedSharedRubrics,
} from "./composition/seed.js";
import { buildCatalog, buildCiLink, buildMattermostCommand, buildQueue, buildView } from "./composition/services.js";
import { buildWorkspace } from "./composition/workspace.js";
import { buildPlacementPreflight } from "./core/execution/placement-preflight.js";
import { buildServer } from "./server.js";

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
    callbackStore,
    usageStore,
    budgetStore,
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

  await seedSharedHarnessTaxonomy(harnessTemplateRegistry, harnessInstanceRegistry);
  // Datasets are not auto-seeded — the first-party examples (examples/datasets/*.json) were noise that cluttered
  // the workspace list. The _shared fallback mechanism itself stays (a real shared benchmark registered later shows through).
  await seedSharedJudges(judgeRegistry);
  await seedSharedRubrics(rubricRegistry);
  await seedSharedModels(modelRegistry);
  // Runtimes are not auto-seeded either — the default _shared docker/local were noise ("whose infra is this?" ambiguity).
  // A runtime is meant to be a workspace registering its own infra (examples/runtimes/*.json kept for reference only).

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
    invalidateTenantBackends,
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
  });

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
  const { service, judgeRunner } = buildRun({
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

  const terminalTickets = new TerminalTicketStore();
  const app = buildServer({
    terminalTickets,
    liveFrames, // live-screen frames pushed by self-hosted runners (report_case_screen MCP tool)
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
    rubricRegistry,
    modelRegistry,
    runtimeRegistry,
    probeRuntime,
    settingsStore,
    workspaceStore,
    workspaceService,
    membershipService,
    profileService,
    secretStore,
    invalidateTenantBackends, // workspace secret change → drop the tenant's cached runtime backends (stale secretEnv)
    githubAppService,
    mattermostService,
    mattermostCommandService,
    traceSinkService,
    traceSourceService,
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
