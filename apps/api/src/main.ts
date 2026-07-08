import { collectAuthEnv } from "@everdict/agent";
import {
  type Authenticator,
  apiKeyAuthenticator,
  compositeAuthenticator,
  githubActionsAuthenticator,
  oidcAuthenticator,
  runnerAuthenticator,
} from "@everdict/auth";
import {
  Autoscaler,
  type Backend,
  BackendRegistry,
  type BudgetLimit,
  CircuitBreaker,
  K8sBackend,
  MutableSlots,
  NomadBackend,
  Scheduler,
  buildRuntimeBackend,
  inMemoryBudget,
} from "@everdict/backends";
import type { CaseResult, RegistryAuth, RuntimeSpec } from "@everdict/core";
import {
  type CommentStore,
  InMemoryCommentStore,
  InMemoryNotificationStore,
  InMemoryOAuthStateStore,
  InMemoryRunStore,
  InMemoryRunnerStore,
  InMemoryScheduleStore,
  InMemoryScorecardStore,
  InMemorySecretStore,
  InMemoryTenantKeyStore,
  InMemoryUserProfileStore,
  InMemoryViewStore,
  InMemoryWorkspaceInviteStore,
  InMemoryWorkspaceSettingsStore,
  InMemoryWorkspaceStore,
  type NotificationStore,
  type OAuthStateStore,
  PgCommentStore,
  PgNotificationStore,
  PgOAuthStateStore,
  PgRunStore,
  PgRunnerStore,
  PgScheduleStore,
  PgScorecardStore,
  PgSecretStore,
  PgTenantKeyStore,
  PgUserProfileStore,
  PgViewStore,
  PgWorkspaceInviteStore,
  PgWorkspaceSettingsStore,
  PgWorkspaceStore,
  type RunStore,
  type RunnerStore,
  type ScheduleStore,
  type ScorecardStore,
  type SecretCipher,
  type SecretStore,
  type TenantKeyStore,
  type UserProfileStore,
  type ViewStore,
  type WorkspaceInviteStore,
  type WorkspaceSettingsStore,
  type WorkspaceStore,
  cipherFromEnv,
  generatedCipher,
  makePool,
  migrate,
  sqlClient,
} from "@everdict/db";
import {
  type BenchmarkRegistry,
  type DatasetRegistry,
  type HarnessInstanceRegistry,
  type HarnessTemplateRegistry,
  InMemoryBenchmarkRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryModelRegistry,
  InMemoryRuntimeRegistry,
  type JudgeRegistry,
  type ModelRegistry,
  PgBenchmarkRegistry,
  PgDatasetRegistry,
  PgHarnessInstanceRegistry,
  PgHarnessTemplateRegistry,
  PgJudgeRegistry,
  PgModelRegistry,
  PgRuntimeRegistry,
  type RuntimeRegistry,
  loadHarnessTaxonomyDir,
  loadJudgeDir,
  loadModelDir,
} from "@everdict/registry";
import { S3ArtifactStore } from "@everdict/storage";
import { InProcessCallbackRendezvous } from "@everdict/topology";
import { buildTraceSink, buildTraceSource } from "@everdict/trace";
import { BenchmarkService } from "./benchmark-service.js";
import { BundleService } from "./bundle-service.js";
import { CiLinkService } from "./ci-link-service.js";
import { CommentService } from "./comment-service.js";
import { GithubAppService, type GithubComAppConfig } from "./github-app-service.js";
import { ImageRegistryService } from "./image-registry-service.js";
import { defaultJudgeRunner } from "./judge-runner.js";
import { MattermostCommandService } from "./mattermost-command-service.js";
import { MattermostService } from "./mattermost-service.js";
import { MembershipService } from "./membership-service.js";
import { ModelResolvingDispatcher } from "./model-resolving-dispatcher.js";
import { NotificationService } from "./notification-service.js";
import { ProfileService } from "./profile-service.js";
import { QueueService } from "./queue-service.js";
import { RunService } from "./run-service.js";
import { RunnerHub } from "./runner-hub.js";
import { RunnerService } from "./runner-service.js";
import { RuntimeDispatcher } from "./runtime-dispatcher.js";
import { makeRuntimeProber } from "./runtime-probe.js";
import { ScheduleService } from "./schedule-service.js";
import { parseAutoscale, parseTenantMap } from "./scheduling-config.js";
import { ScorecardService } from "./scorecard-service.js";
import { SelfHostedBackend } from "./self-hosted-backend.js";
import { buildServer } from "./server.js";
import { recoverInterrupted } from "./startup-recovery.js";
import { TemporalBatchDriver } from "./temporal-batch-driver.js";
import { TemporalScheduleDriver } from "./temporal-schedule-driver.js";
import { buildTopologyBackend } from "./topology-backend.js";
import { TraceSinkService } from "./trace-sink-service.js";
import { ViewService } from "./view-service.js";
import { WorkspaceService } from "./workspace-service.js";

// Multi-tenant control-plane server. tenant is derived from the Bearer API key (dev header fallback if absent).
// DATABASE_URL → Postgres (stores/keys/registries), else in-memory. NOMAD_ADDR → Nomad backend.
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
    modelRegistry,
    runtimeRegistry,
    settingsStore,
    workspaceStore,
    userProfileStore,
    inviteStore,
    secretStore,
    oauthStateStore,
    runnerStore,
    scheduleStore,
    notificationStore,
    commentStore,
    viewStore,
  } = await makePersistence();
  const workspaceService = new WorkspaceService(workspaceStore);
  // scheduleService is created below (it depends on scorecardService), but the member-removal hook late-binds it via a closure
  // — the hook is only called at runtime (when a member leaves), by which point it is already assigned.
  // biome-ignore lint/style/useConst: declaration↔assignment must be split (circular creation order) — the member-removal hook closure captures this binding.
  let scheduleService: ScheduleService;
  const membershipService = new MembershipService(workspaceStore, inviteStore, userProfileStore, (ws, sub) =>
    scheduleService.disableByCreator(ws, sub),
  );
  const profileService = new ProfileService(userProfileStore);
  const runnerService = new RunnerService(runnerStore);
  await seedSharedHarnessTaxonomy(harnessTemplateRegistry, harnessInstanceRegistry);
  // Datasets are not auto-seeded — the first-party examples (examples/datasets/*.json) were noise that cluttered
  // the workspace list. The _shared fallback mechanism itself stays (a real shared benchmark registered later shows through).
  await seedSharedJudges(judgeRegistry);
  await seedSharedModels(modelRegistry);
  // Runtimes are not auto-seeded either — the default _shared docker/local were noise ("whose infra is this?" ambiguity).
  // A runtime is meant to be a workspace registering its own infra (examples/runtimes/*.json kept for reference only).

  // Inject workspace secrets (model/provider keys) only into that tenant's job env (no leakage). The store is always active.
  const secrets = { secretsFor: (tenant: string) => secretStore.entries(tenant) };

  const backends = new BackendRegistry();
  // Slot autoscaling (EVERDICT_AUTOSCALE="min:max[:intervalMs]") — global env backends only: their slot cap
  // becomes a MutableSlots the Autoscaler grows with queue depth (a downstream cluster autoscaler then sees the
  // pending work) and shrinks after idle hysteresis. Tenant runtimes keep their spec-declared envelope.
  const autoscale = parseAutoscale(process.env.EVERDICT_AUTOSCALE);
  const scalingTargets: MutableSlots[] = [];
  const slotsFor = (name: string): MutableSlots | undefined => {
    if (!autoscale) return undefined;
    const slots = new MutableSlots(name, Math.max(1, autoscale.min));
    scalingTargets.push(slots);
    return slots;
  };
  if (nomadAddr && image) {
    const slots = slotsFor("nomad");
    backends.register(
      "nomad",
      new NomadBackend({
        addr: nomadAddr,
        image,
        secretEnv: collectAuthEnv(),
        secrets,
        ...(slots ? { maxConcurrent: slots.get } : {}),
      }),
    );
  } else if (k8sContext && image) {
    const slots = slotsFor("k8s");
    backends.register(
      "k8s",
      new K8sBackend({
        image,
        context: k8sContext,
        secretEnv: collectAuthEnv(),
        secrets,
        ...(slots ? { maxConcurrent: slots.get } : {}),
      }),
    );
  }
  // Policy (default): never register LocalBackend (unisolated in-process on the control-plane host) — every run must
  // target a registered tenant runtime or a self-hosted runner (self:<id>/self:ws). This is the default with no opt-in env.
  // (For dev/single-host in-process runs use apps/cli's `everdict run` — the API only does managed/remote execution.)
  // Operator fairness dials (docs/execution-backends.md): per-tenant concurrent caps + WFQ weights. Unset = the
  // previous defaults (unlimited quota, weight 1) — the fairness machinery is always on; these are just the dials.
  const tenantQuotas = parseTenantMap(process.env.EVERDICT_TENANT_QUOTAS, "EVERDICT_TENANT_QUOTAS");
  const tenantWeights = parseTenantMap(process.env.EVERDICT_TENANT_WEIGHTS, "EVERDICT_TENANT_WEIGHTS");
  const scheduler = new Scheduler(backends, {
    ...(tenantQuotas ? { tenantQuota: (t: string) => tenantQuotas.get(t) ?? Number.POSITIVE_INFINITY } : {}),
    ...(tenantWeights ? { weightFor: (t: string) => tenantWeights.get(t) ?? 1 } : {}),
  });
  // Per-runtime circuit breaker — shared between the batch spillover (ScorecardService) and the queue view
  // (observability): one health memory, two consumers.
  const breaker = new CircuitBreaker();
  if (autoscale && scalingTargets.length > 0) {
    const autoscaler = new Autoscaler({
      // Demand = this deployment's whole backlog + what the global backends already run (tenant-runtime jobs
      // never target these slots, but their queue share still signals pressure — clamped by max anyway).
      signal: () => {
        const s = scheduler.stats();
        const inFlight = scalingTargets.reduce((a, t) => a + (s.inFlight[t.id] ?? 0), 0);
        return { queued: s.queued, inFlight };
      },
      targets: scalingTargets,
      policy: { min: autoscale.min, max: autoscale.max },
      ...(autoscale.intervalMs !== undefined ? { intervalMs: autoscale.intervalMs } : {}),
      onScale: (id, from, to) => console.log(`▶ autoscale ${id}: ${from} → ${to} slots`),
      onChanged: () => scheduler.poke(), // re-pump so newly-granted slots drain the queue immediately
    });
    autoscaler.start();
    console.log(
      `▶ autoscale: [${scalingTargets.map((t) => t.id).join(", ")}] slots ${autoscale.min}..${autoscale.max}`,
    );
  }
  const budget = inMemoryBudget({ limitFor: budgetFromEnv() });

  // Self-hosted runner lease hub — parks self:<runnerId> jobs; the runner protocol (MCP, slice 4) leases/returns them.
  // A single instance shared by the dispatcher (park) and the MCP lease/result tools (lease/complete).
  const runnerHub = new RunnerHub(
    process.env.EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS
      ? { queueTimeoutMs: Number(process.env.EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS) }
      : {},
  );

  // Front-door callback completion model: when a public base URL is set, build one in-process rendezvous shared by the topology
  // backend (outbound: {{callback_url}}/wait) and the /frontdoor-callback route (inbound: deliver). If unset, the callback model
  // fails clearly in the driver (no rendezvous). Assumes a single control-plane process (in-process dispatch) — distribution via a store-backed rendezvous is a follow-up.
  const callbackRendezvous = process.env.EVERDICT_CALLBACK_BASE_URL
    ? new InProcessCallbackRendezvous(process.env.EVERDICT_CALLBACK_BASE_URL)
    : undefined;
  if (callbackRendezvous) console.log("▶ front-door callback rendezvous:", process.env.EVERDICT_CALLBACK_BASE_URL);

  // Tenant runtime routing: if placement.target is a tenant-registered Runtime, build/register that backend and route to it (else the global backend as-is).
  const runtimeSecretsFor = (tenant: string) => secretStore.entries(tenant);
  // Two tiers for resolving harness env {secretRef} — shared (owner='') + submitter's personal (owner=subject). run/scorecard call as the submitter.
  const scopedSecretsFor = (tenant: string, subject?: string) => secretStore.scopedEntries(tenant, subject ?? "");
  // Workspace image registry (BYO) — the harness image classification baseline + `everdict image push` publish target + pull-credential injection.
  // The runtime builder / dispatch enrichment uses pullAuth, so create it beforehand.
  const imageRegistryService = new ImageRegistryService({
    settings: settingsStore,
    secretsFor: runtimeSecretsFor, // push/pull credentials + registration warnings resolve from the shared (workspace) secret tier
  });
  // RuntimeSpec → live backend. nomad/k8s with a traceSource (= topology-capable) → ServiceTopologyBackend,
  // everything else → buildRuntimeBackend (local/nomad/k8s). (The old topology kind was folded into nomad/k8s + traceSource in slice 5b-2.)
  // Defined in one place so dispatch and the connection test (probe) share the same builder/auth path.
  const runtimeBuildBackend = (
    spec: RuntimeSpec,
    opts: { secretEnv?: Record<string, string>; registryAuth?: RegistryAuth },
  ) =>
    (spec.kind === "nomad" || spec.kind === "k8s") && spec.traceSource
      ? buildTopologyBackend(spec, {
          harnesses: harnessInstanceRegistry,
          ...(callbackRendezvous ? { callbackRendezvous } : {}),
          // Workspace registry pull credentials — the topology runtime authenticates when pulling service images (nomad auth / k8s imagePullSecrets).
          ...(opts.registryAuth ? { registryAuth: opts.registryAuth } : {}),
        })
      : buildRuntimeBackend(spec, opts);
  // Resolve a command harness's {{model}} to a registered Model id (else raw), then delegate to RuntimeDispatcher (placement).
  // run/judge/scorecard share this one dispatcher, so every path runs with the identically-resolved model.
  const dispatcher = new ModelResolvingDispatcher(
    modelRegistry,
    new RuntimeDispatcher({
      inner: scheduler,
      backends,
      runtimes: runtimeRegistry,
      secretsFor: runtimeSecretsFor,
      buildBackend: runtimeBuildBackend,
      // Workspace registry pull credentials — carried into the topology backend build to authenticate service-image pulls.
      registryAuthsFor: (tenant) => imageRegistryService.pullAuths(tenant),
      // self:<runnerId> — personally-owned runner. Confirm ownership (not owned = undefined) + return that runner's capabilities (for the service gate).
      resolveSelfRunner: async (owner, runnerId) => (await runnerStore.get(owner, runnerId))?.capabilities,
      // self:ws — workspace pool. Whether that owner (=ws:<tenant>) has any runner at all (lease any runner).
      poolHasRunners: async (owner) => (await runnerStore.list(owner)).length > 0,
      buildSelfHostedBackend: (key) => new SelfHostedBackend(key, runnerHub),
    }),
  );
  // Connection test: build a backend with the same builder + tenant secrets and probe() (reachability/auth with no job). Shared by server/MCP.
  const probeRuntime = makeRuntimeProber({ secretsFor: runtimeSecretsFor, buildBackend: runtimeBuildBackend });

  // Artifact store (when env-configured): offload os-use screenshots to S3/MinIO → result records carry only a presigned URL (no base64 inline).
  // Unset → undefined → the service falls back to base64 inline (dev). Credentials are env secrets (never committed).
  const artifacts = await artifactStoreFromEnv();
  if (artifacts) console.log("▶ artifact store: S3/MinIO offload enabled (os-use screenshots)");

  const envMeterPolicy = meterUsagePolicyFromEnv(); // default policy when the workspace has no DB setting
  // Completion notifications: when workspace notify settings exist (Mattermost connection + channel), post run/scorecard completion to the channel (consumer slice).
  const notificationService = new NotificationService({
    settingsFor: (tenant) => settingsStore.get(tenant),
    // Workspace Mattermost (bot token) — resolve settings.mattermost.botTokenSecretName from shared secrets.
    secretsFor: runtimeSecretsFor,
    feed: notificationStore, // personal notification feed (bell inbox) — docs/architecture/notifications.md
  });
  // Workspace-owned Mattermost integration (register → bot notifications + inbound slash commands/buttons). apiPublicUrl exposes the inbound URL.
  const mattermostService = new MattermostService(settingsStore, {
    ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}),
  });
  // Workspace trace sinks — export scorecard detail results to the team's observability platform. docs/architecture/trace-sink.md
  const traceSinkService = new TraceSinkService(settingsStore, {
    secretsFor: runtimeSecretsFor, // authSecretName → shared (workspace) secret value
    buildSink: buildTraceSink,
  });
  // Resource comments (datasets, etc.) for collaborative discussion + @mention notifications. On a mention, resolve the mentioner's name from profile/membership into the personal feed.
  const commentService = new CommentService({
    store: commentStore,
    notifyMention: async ({ tenant, comment, recipients }) => {
      // listMembers already merges in profile names — the mentioner's display name (name > email local-part > default).
      const member = await membershipService
        .listMembers(tenant)
        .then((ms) => ms.find((m) => m.subject === comment.author))
        .catch(() => undefined);
      const actorName = member?.name ?? member?.email?.split("@")[0] ?? "someone";
      await notificationService.notifyMention(tenant, {
        recipients,
        actorName,
        resourceType: comment.resourceType,
        resourceId: comment.resourceId,
        commentId: comment.id,
        preview: comment.body,
      });
    },
  });
  // Workspace-owned GitHub App integration — org install → selected repos → workspace-owned installation (replaces personal connections).
  // github.com App = operator env (GITHUB_APP_*); GHE App = admin registers it on the workspace (private key = SecretStore name-ref).
  // RunService/ScorecardService's installationTokenFor calls this, so create it beforehand.
  const githubComApp = githubComAppConfig();
  const githubAppService = new GithubAppService({
    states: oauthStateStore,
    settings: settingsStore,
    secretsFor: runtimeSecretsFor,
    config: {
      webBaseUrl: process.env.WEB_BASE_URL ?? "http://localhost:3001",
      ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}),
      ...(githubComApp ? { githubCom: githubComApp } : {}),
    },
  });
  if (githubComApp)
    console.error("▶ github-app: github.com App enabled (GITHUB_APP_ID/SLUG) — org install → selected-repo one-click");
  else
    console.warn(
      "▶ github-app: GITHUB_APP_* unset — github.com App install disabled (GHE still works when an admin registers it on the workspace).",
    );

  const service = new RunService({
    dispatcher,
    store,
    budget,
    requireRuntime: true, // policy (default): a run with no runtime/self target is 400 at submit — the API does not register local
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
    ...(process.env.EVERDICT_JUDGE_OPENAI_BASE_URL
      ? { openaiBaseUrl: process.env.EVERDICT_JUDGE_OPENAI_BASE_URL }
      : {}),
  });
  // Batch eval: run a dataset (bundle of cases) against a harness@version, aggregate into a scorecard + apply the selected judges to each trace.
  // Batch-on-Temporal (opt-in): the durable workflow drives batches through the internal routes.
  const temporalBatchAddress =
    process.env.EVERDICT_TEMPORAL_ADDRESS && process.env.EVERDICT_TEMPORAL_BATCHES === "1"
      ? process.env.EVERDICT_TEMPORAL_ADDRESS
      : undefined;
  // Boot-recovery adoption + supersede force-kill: resolve each runtime of the child's recorded lane (may be a
  // comma shard list) to a live backend and use its optional adopt/kill. Best-effort by design — a miss falls
  // back to re-dispatch (adopt) or leaves the job to finish unobserved (kill).
  const eachRuntimeBackend = async (
    tenant: string,
    runtimeList: string | undefined,
    fn: (backend: Backend) => Promise<boolean>, // return true to stop iterating (handled)
  ): Promise<void> => {
    const targets = (runtimeList ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "" && !t.startsWith("self:")); // self-hosted lanes are lease queues — nothing to adopt/kill
    for (const target of targets) {
      const spec = await runtimeRegistry.get(tenant, target).catch(() => undefined);
      if (!spec) continue;
      const secretEnv = await runtimeSecretsFor(tenant).catch(() => ({}) as Record<string, string>);
      const backend = runtimeBuildBackend(spec, { secretEnv });
      if (await fn(backend)) return;
    }
  };

  const scorecardService = new ScorecardService({
    dispatcher,
    store: scorecardStore,
    breaker, // shared with the queue view — spillover writes, observability reads
    adoptCase: async (tenant, runtimeList, caseId) => {
      let adopted: CaseResult | undefined;
      await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
        if (!backend.adopt) return false;
        adopted = await backend.adopt(caseId).catch(() => undefined);
        return adopted !== undefined;
      });
      return adopted;
    },
    killCase: async (tenant, runtimeList, caseId) => {
      await eachRuntimeBackend(tenant, runtimeList, async (backend) => {
        if (!backend.kill) return false;
        await backend.kill(caseId).catch(() => {});
        return false; // every runtime of the shard list gets the kill (the case may live on any of them)
      });
    },
    ...(temporalBatchAddress
      ? {
          temporalBatches: new TemporalBatchDriver({
            address: temporalBatchAddress,
            // History-budget dial: settled cases per workflow execution before continue-as-new (default 500 in the workflow).
            ...(process.env.EVERDICT_TEMPORAL_BATCH_CONTINUE_EVERY
              ? { continueEvery: Number(process.env.EVERDICT_TEMPORAL_BATCH_CONTINUE_EVERY) }
              : {}),
          }),
        }
      : {}),
    // runtime:"auto" — expand to every registered runtime id for the tenant (sharding across all of them).
    runtimesFor: async (tenant) => (await runtimeRegistry.list(tenant)).map((r) => r.id),
    requireRuntime: true, // policy (default): a batch with no runtime is 400 at submit — the API does not register local
    // Fan out a child run per case (sharing the same RunStore as a single run) — each case becomes an addressable run, hidden by default in the activity list.
    runStore: store,
    datasets: datasetRegistry,
    harnesses: harnessInstanceRegistry,
    judges: judgeRegistry,
    judgeRunner,
    budget,
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

  // Recover orphaned jobs at boot — batches/runs are tracked in-process within this process, so at restart any
  // queued/running record is a ghost with no one to resume it. Interrupted BATCHES are resumed from their finished
  // child results (unfinished cases re-dispatched); unresumable records fall back to failed(INTERRUPTED).
  // docs/architecture/batch-resilience.md
  const recovered = await recoverInterrupted({
    scorecards: scorecardStore,
    runs: store,
    resume: (id) => scorecardService.resume(id),
  });
  if (recovered.scorecards + recovered.resumed + recovered.runs > 0)
    console.error(
      `▶ boot recovery: batches resumed ${recovered.resumed} · batches failed(INTERRUPTED) ${recovered.scorecards} · runs failed ${recovered.runs}`,
    );
  // Mattermost inbound (slash commands/buttons) — after commandToken verification, run a scorecard / view the leaderboard from chat.
  const mattermostCommandService = new MattermostCommandService({
    settings: settingsStore,
    secretsFor: runtimeSecretsFor, // resolve (verify) the commandTokenSecretName value — a workspace shared secret
    submitScorecard: async (workspace, { dataset, harness, submittedBy }) => {
      const rec = await scorecardService.submit({
        tenant: workspace,
        submittedBy,
        dataset: { id: dataset, version: "latest" },
        harness: { id: harness, version: "latest" },
        origin: { source: "mattermost" },
      });
      return { id: rec.id };
    },
    leaderboard: async (workspace, datasetId) => {
      const lb = await scorecardService.leaderboard(workspace, { datasetId, metric: "tests_pass" });
      return lb.rows.map((r) => ({
        label: `${r.harness.id}@${r.harness.version}`,
        value: r.score !== null ? r.score.toFixed(3) : "—",
      }));
    },
    webBaseUrl: process.env.WEB_BASE_URL ?? "http://localhost:3001",
  });
  // Benchmark catalog import: pull a first-party benchmark by ID alone and register it as a tenant dataset. Gated ones use the HF_TOKEN secret.
  const benchmarkService = new BenchmarkService({
    datasets: datasetRegistry,
    benchmarks: benchmarkRegistry,
    // Gated HF auth — the requester's "personal" secret first, workspace-shared fallback. A member can, without an admin,
    // just put HF_TOKEN in their account secrets and self-serve import a gated benchmark from the web.
    secretsFor: async (tenant, subject) => {
      const scoped = await secretStore.scopedEntries(tenant, subject ?? "");
      return { ...scoped.workspace, ...scoped.user };
    },
  });
  // Bundle one-shot install — fan out over the existing registries (harness + benchmark + dataset + runtime + judge/model). No new store.
  const bundleService = new BundleService({
    harnessTemplates: harnessTemplateRegistry,
    harnessInstances: harnessInstanceRegistry,
    benchmarks: benchmarkService,
    datasets: datasetRegistry,
    judges: judgeRegistry,
    models: modelRegistry,
    runtimes: runtimeRegistry,
  });
  // CI repo link — repo↔harness-slot mapping (= GitHub Actions OIDC trust) CRUD + repo picker + setup-PR generator.
  // The picker/setup-PR use the member's personal GitHub connection token (tokenFor) only server-side.
  const ciLinkService = new CiLinkService({
    settings: settingsStore,
    githubApp: githubAppService, // repo picker + setup-PR + runner registration token = the workspace GitHub App (replaces personal connections)
    runners: runnerService, // setup-PR checks the self:ws pool exists (D6 — CI placement is always self-hosted, fail-closed)
    ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}), // api-url of the generated workflow
  });

  // Scheduled (cron) scorecards. SSOT = scheduleStore; when a Temporal address is set, sync the Schedule via TemporalScheduleDriver
  // (firing enabled). Firing goes workflow → internal route → submitScorecard here. Unset → CRUD only (firing disabled, dev).
  const temporalAddress = process.env.EVERDICT_TEMPORAL_ADDRESS;
  scheduleService = new ScheduleService({
    store: scheduleStore,
    ...(temporalAddress ? { driver: new TemporalScheduleDriver({ address: temporalAddress }) } : {}),
    submitScorecard: (sc) => scorecardService.submit(sc),
    scorecardStatus: async (id) => (await scorecardService.get(id))?.status,
    // Regression alert: diff previous↔this schedule run (both must be complete) → Mattermost on regression (completion notification is separate, via the scorecard onComplete).
    diffScorecards: (tenant, baselineId, candidateId) => scorecardService.diff(tenant, baselineId, candidateId),
    notifyRegression: (tenant, payload) => notificationService.notifyRegression(tenant, payload),
  });

  // Work queue snapshot — what is running/waiting where (runtime lane) right now, and what the next scheduled fire is (read-only visibility).
  const queueService = new QueueService({
    scorecards: scorecardStore,
    runs: store,
    schedules: scheduleService,
    runtimes: runtimeRegistry,
    // Personal queue scope — expose only the requester's own runners (self:<id>) as a personal queue (other members' are hidden). label = hostname.
    myRunners: async (subject) => (await runnerService.list(subject)).map((r) => ({ id: r.id, label: r.label })),
    // A batch's progress total = number of dataset cases (omitted if resolution fails — progress then relies only on the child-run count).
    caseCountFor: async (tenant, id, version) => (await datasetRegistry.get(tenant, id, version)).cases.length,
    // Scheduler observability — lane admission (in-flight/memory envelope/circuit) + the workspace scheduler slice.
    schedulerStats: () => scheduler.stats(),
    circuitStats: () => breaker.stats(),
    ...(tenantQuotas ? { tenantQuotaFor: (t: string) => tenantQuotas.get(t) } : {}),
    runtimeEnvelopeFor: async (tenant, id) => {
      const spec = await runtimeRegistry.get(tenant, id).catch(() => undefined);
      if (!spec) return undefined;
      return {
        ...(spec.maxConcurrent !== undefined ? { maxConcurrent: spec.maxConcurrent } : {}),
        ...(spec.memoryBudgetMb !== undefined ? { memoryBudgetMb: spec.memoryBudgetMb } : {}),
      };
    },
  });

  // Saved scorecard-analysis Views — store/share a named AnalysisConfig (opaque config) on the workspace. Live re-run, so no snapshot.
  const viewService = new ViewService({ store: viewStore });

  const app = buildServer({
    service,
    scorecardService,
    scheduleService,
    queueService,
    viewService,
    benchmarkService,
    bundleService,
    harnessTemplates: harnessTemplateRegistry,
    harnessInstances: harnessInstanceRegistry,
    datasetRegistry,
    judgeRegistry,
    modelRegistry,
    runtimeRegistry,
    probeRuntime,
    settingsStore,
    workspaceStore,
    workspaceService,
    membershipService,
    profileService,
    secretStore,
    githubAppService,
    mattermostService,
    mattermostCommandService,
    traceSinkService,
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

interface Persistence {
  store: RunStore;
  scorecardStore: ScorecardStore;
  keyStore: TenantKeyStore;
  harnessTemplateRegistry: HarnessTemplateRegistry; // harness category (template structure)
  harnessInstanceRegistry: HarnessInstanceRegistry; // individual harness (template+pins → resolved)
  datasetRegistry: DatasetRegistry;
  benchmarkRegistry: BenchmarkRegistry;
  judgeRegistry: JudgeRegistry;
  modelRegistry: ModelRegistry;
  runtimeRegistry: RuntimeRegistry;
  settingsStore: WorkspaceSettingsStore; // workspace settings (metering policy, etc.) — always available
  workspaceStore: WorkspaceStore; // workspace membership (create/switch) — always available
  userProfileStore: UserProfileStore; // user profile (name/username/avatar) — always available
  inviteStore: WorkspaceInviteStore; // member invites (token/link redemption) — always available
  secretStore: SecretStore; // always available (on by default) — KEK is EVERDICT_SECRETS_KEY, else an ephemeral key is auto-generated
  oauthStateStore: OAuthStateStore; // one-shot pending state for OAuth authorize→callback
  runnerStore: RunnerStore; // self-hosted runners (personal device pairing) — only the SHA-256 hash of the pairing token is stored
  scheduleStore: ScheduleStore; // scheduled (cron) scorecards — stored RunScorecardInput + cron expression (SSOT, mutable)
  notificationStore: NotificationStore; // personal notification feed (bell inbox) — records run/scorecard completion with recipient=subject
  commentStore: CommentStore; // resource comments (datasets, etc.) — collaborative discussion
  viewStore: ViewStore; // saved scorecard-analysis Views (named AnalysisConfig, private|workspace) — live re-run
}

// At-rest encryption KEK: use EVERDICT_SECRETS_KEY (base64 32B) if present, otherwise auto-generate an ephemeral key
// to keep the secrets feature "on by default" (no branch / no fail-closed). On auto-generation, warn once about Pg persistence.
function resolveSecretCipher(): SecretCipher {
  const fromEnv = cipherFromEnv();
  if (fromEnv) return fromEnv;
  console.error(
    "▶ EVERDICT_SECRETS_KEY unset — auto-generating an ephemeral KEK to enable the secrets feature (on by default). " +
      "For persistent (Postgres) operation, pin EVERDICT_SECRETS_KEY (base64 32B) — an ephemeral key changes every restart and cannot decrypt existing secrets.",
  );
  return generatedCipher();
}

// DATABASE_URL → Postgres (migrations applied at startup), else in-memory.
// The secret store is always active (on by default). The at-rest encryption KEK is EVERDICT_SECRETS_KEY (base64 32B); if unset, an ephemeral key is
// auto-generated — safe in-memory since it's volatile, but persistent Pg operation must pin the key via EVERDICT_SECRETS_KEY (restart decryption).
async function makePersistence(): Promise<Persistence> {
  const cipher = resolveSecretCipher();
  const url = process.env.DATABASE_URL;
  if (!url) {
    const workspaceStore = new InMemoryWorkspaceStore();
    const harnessTemplateRegistry = new InMemoryHarnessTemplateRegistry();
    return {
      store: new InMemoryRunStore(),
      scorecardStore: new InMemoryScorecardStore(),
      keyStore: new InMemoryTenantKeyStore(),
      harnessTemplateRegistry,
      harnessInstanceRegistry: new InMemoryHarnessInstanceRegistry(harnessTemplateRegistry),
      datasetRegistry: new InMemoryDatasetRegistry(),
      benchmarkRegistry: new InMemoryBenchmarkRegistry(),
      judgeRegistry: new InMemoryJudgeRegistry(),
      modelRegistry: new InMemoryModelRegistry(),
      runtimeRegistry: new InMemoryRuntimeRegistry(),
      settingsStore: new InMemoryWorkspaceSettingsStore(),
      workspaceStore,
      userProfileStore: new InMemoryUserProfileStore(),
      inviteStore: new InMemoryWorkspaceInviteStore(workspaceStore),
      secretStore: new InMemorySecretStore(cipher),
      oauthStateStore: new InMemoryOAuthStateStore(),
      runnerStore: new InMemoryRunnerStore(),
      scheduleStore: new InMemoryScheduleStore(),
      notificationStore: new InMemoryNotificationStore(),
      commentStore: new InMemoryCommentStore(),
      viewStore: new InMemoryViewStore(),
    };
  }
  const client = sqlClient(makePool(url));
  const { applied } = await migrate(client);
  if (applied.length > 0) console.error(`▶ db migrations applied: ${applied.join(", ")}`);
  const harnessTemplateRegistry = new PgHarnessTemplateRegistry(client);
  return {
    store: new PgRunStore(client),
    scorecardStore: new PgScorecardStore(client),
    keyStore: new PgTenantKeyStore(client),
    harnessTemplateRegistry,
    harnessInstanceRegistry: new PgHarnessInstanceRegistry(client, harnessTemplateRegistry),
    datasetRegistry: new PgDatasetRegistry(client),
    benchmarkRegistry: new PgBenchmarkRegistry(client),
    judgeRegistry: new PgJudgeRegistry(client),
    modelRegistry: new PgModelRegistry(client),
    runtimeRegistry: new PgRuntimeRegistry(client),
    settingsStore: new PgWorkspaceSettingsStore(client),
    workspaceStore: new PgWorkspaceStore(client),
    userProfileStore: new PgUserProfileStore(client),
    inviteStore: new PgWorkspaceInviteStore(client),
    secretStore: new PgSecretStore(client, cipher),
    oauthStateStore: new PgOAuthStateStore(client),
    runnerStore: new PgRunnerStore(client),
    scheduleStore: new PgScheduleStore(client),
    notificationStore: new PgNotificationStore(client),
    commentStore: new PgCommentStore(client),
    viewStore: new PgViewStore(client),
  };
}

// Seed the _shared harness taxonomy (template categories + instances) from the file SSOT. EVERDICT_HARNESS_TEMPLATES_DIR
// (else cwd/examples/harness-templates). *.template.json → template, *.instance.json → instance. Best-effort/idempotent.
async function seedSharedHarnessTaxonomy(
  templates: HarnessTemplateRegistry,
  instances: HarnessInstanceRegistry,
): Promise<void> {
  const dir = process.env.EVERDICT_HARNESS_TEMPLATES_DIR ?? `${process.cwd()}/examples/harness-templates`;
  try {
    await loadHarnessTaxonomyDir(dir, { templates, instances });
    console.error(`▶ shared harness taxonomy seeded from ${dir}`);
  } catch {
    // A missing/empty directory is normal.
  }
}

// Seed _shared (first-party default judges) from the file SSOT — a new tenant can use the default judges immediately. Best-effort/idempotent.
async function seedSharedJudges(registry: JudgeRegistry): Promise<void> {
  const dir = process.env.EVERDICT_JUDGES_DIR ?? `${process.cwd()}/examples/judges`;
  try {
    await loadJudgeDir(dir, { into: registry });
    console.error(`▶ shared judges seeded from ${dir}`);
  } catch {
    // A missing/empty directory is normal (boot with no seed).
  }
}

// Seed _shared (first-party default models) from the file SSOT — a new tenant can reference the registered models from a judge/harness immediately. Best-effort/idempotent.
async function seedSharedModels(registry: ModelRegistry): Promise<void> {
  const dir = process.env.EVERDICT_MODELS_DIR ?? `${process.cwd()}/examples/models`;
  try {
    await loadModelDir(dir, { into: registry });
    console.error(`▶ shared models seeded from ${dir}`);
  } catch {
    // A missing/empty directory is normal (boot with no seed).
  }
}

// External account-connection provider registry.
//  - github (github.com): one-click (default) if the env default OAuth App exists. Otherwise it registers but doesn't appear in the connectable list.
//  - github-enterprise: same github impl + self-hosted (on connect, enter host + clientId + clientSecretName).
//  - mattermost: self-hosted only.
// A self-hosted client_secret value is resolved by NAME from the workspace SecretStore (the value is never stored in the spec/state).
// github.com operator App credentials (env) — all three required to enable. For the private key (PEM), for single-line env-file safety,
// base64(PEM) is recommended; if it contains "BEGIN", raw PEM (with \n escape restoration) is also accepted. Unset → github.com App install disabled.
function githubComAppConfig(): GithubComAppConfig | undefined {
  const appId = process.env.GITHUB_APP_ID;
  const key = process.env.GITHUB_APP_PRIVATE_KEY;
  const slug = process.env.GITHUB_APP_SLUG;
  if (!appId || !key || !slug) return undefined;
  const privateKeyPem = key.includes("BEGIN") ? key.replace(/\\n/g, "\n") : Buffer.from(key, "base64").toString("utf8");
  return { appId, slug, privateKeyPem };
}

// Auth owned by the control plane: KEYCLOAK_ISSUER → OIDC(JWT) + always API keys. Both resolve to a workspace.
function buildAuthenticator(
  keyStore: TenantKeyStore,
  runnerStore: RunnerStore,
  settingsStore: WorkspaceSettingsStore,
): Authenticator {
  const authers: Authenticator[] = [];
  // GitHub Actions OIDC federation — keyless CI. It pre-checks the issuer and silently passes Keycloak/other JWTs, so
  // put it before the OIDC(Keycloak) authenticator (reversed, a CI token would leave a Keycloak-verification-failed warn log).
  // Trust = a repo-link match (WorkspaceSettings.ci.links) in the named workspace (x-everdict-workspace) → roles=["ci"].
  // GHES supported too: only dynamically trust the issuer (https://<host>/_services/token) of a host that has a GHE link (fail-closed);
  // link matching is (host, repository) — a github.com token cannot pass a same-named GHE link (or vice versa).
  const normHost = (h?: string): string | undefined => h?.replace(/\/$/, "").toLowerCase();
  authers.push(
    githubActionsAuthenticator({
      resolveTrust: async (claims, workspaceHint) => {
        const settings = await settingsStore.get(workspaceHint);
        const link = settings?.ci?.links.find(
          (l) =>
            !l.disabled &&
            normHost(l.host) === normHost(claims.host) &&
            l.repository.toLowerCase() === claims.repository.toLowerCase(),
        );
        return link ? { workspace: workspaceHint, roles: ["ci"] } : undefined;
      },
      enterprise: {
        // Hosts this workspace has trusted via a GHE link — only GHES tokens from those issuers become verification candidates.
        hostsFor: async (workspaceHint) => {
          const settings = await settingsStore.get(workspaceHint);
          const hosts = new Set<string>();
          for (const l of settings?.ci?.links ?? []) if (!l.disabled && l.host) hosts.add(l.host);
          return [...hosts];
        },
      },
    }),
  );
  if (process.env.KEYCLOAK_ISSUER) {
    console.error(`▶ auth: OIDC(JWT) verifier enabled issuer=${process.env.KEYCLOAK_ISSUER}`);
    authers.push(
      oidcAuthenticator({
        issuer: process.env.KEYCLOAK_ISSUER,
        ...(process.env.OIDC_AUDIENCE ? { audience: process.env.OIDC_AUDIENCE } : {}),
        ...(process.env.WORKSPACE_CLAIM ? { workspaceClaim: process.env.WORKSPACE_CLAIM } : {}),
        // Log the reason a JWT failed verification to the control-plane log (401 causes: issuer mismatch / JWKS unreachable / expired / signature / aud).
        onError: (info) =>
          console.warn(
            `▶ auth: OIDC token verification failed [${info.code}] ${info.message} ` +
              `| expectedIssuer=${info.expectedIssuer} tokenIssuer=${info.tokenIssuer ?? "(none)"} ` +
              `tokenAud=${JSON.stringify(info.tokenAudience ?? null)} claims=[${(info.claimKeys ?? []).join(",")}]`,
          ),
      }),
    );
  } else {
    // The most common cause of internal SSO tokens getting 401'd — warn loudly at boot (case: only the web wired SSO, the control plane left unset).
    console.warn(
      "▶ auth: KEYCLOAK_ISSUER unset — OIDC(JWT) verifier disabled (API keys only). Internal SSO access tokens will be 401'd.",
    );
  }
  authers.push(apiKeyAuthenticator({ keyStore }));
  // Self-hosted runner pairing token (rnr_) — `everdict runner` authenticates to MCP. Resolves to owner/workspace/runnerId, least-privilege.
  authers.push(runnerAuthenticator({ runnerStore }));
  return compositeAuthenticator(authers);
}

// Per-workspace metering policy: if EVERDICT_METER_TENANTS (comma list) is set, only those tenants; otherwise EVERDICT_METER_USAGE=1
// is the all-tenant default. A per-request override (POST /runs body.meterUsage) always wins.
function meterUsagePolicyFromEnv(): (tenant: string) => boolean {
  const list = process.env.EVERDICT_METER_TENANTS;
  if (list) {
    const allow = new Set(
      list
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    return (tenant) => allow.has(tenant);
  }
  const all = process.env.EVERDICT_METER_USAGE === "1";
  return () => all;
}

function budgetFromEnv(): (tenant: string) => BudgetLimit | undefined {
  const runs = process.env.EVERDICT_TENANT_RUNS ? Number(process.env.EVERDICT_TENANT_RUNS) : undefined;
  const usd = process.env.EVERDICT_TENANT_USD ? Number(process.env.EVERDICT_TENANT_USD) : undefined;
  if (runs === undefined && usd === undefined) return () => undefined;
  const limit: BudgetLimit = { ...(runs !== undefined ? { runs } : {}), ...(usd !== undefined ? { usd } : {}) };
  return () => limit;
}

// Artifact (screenshot) object storage: if all 4 env vars (endpoint/bucket/access/secret) are present, configure the S3/MinIO store + ensure the bucket.
// Unset → undefined → os-use screenshots fall back to base64 inline (dev). Secrets are env (secrets) — never in the spec/committed.
async function artifactStoreFromEnv(): Promise<S3ArtifactStore | undefined> {
  const endpoint = process.env.EVERDICT_S3_ENDPOINT;
  const bucket = process.env.EVERDICT_S3_BUCKET;
  const accessKeyId = process.env.EVERDICT_S3_ACCESS_KEY;
  const secretAccessKey = process.env.EVERDICT_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  const store = new S3ArtifactStore({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(process.env.EVERDICT_S3_REGION ? { region: process.env.EVERDICT_S3_REGION } : {}),
    ...(process.env.EVERDICT_S3_PUBLIC_URL ? { publicBaseUrl: process.env.EVERDICT_S3_PUBLIC_URL } : {}),
  });
  await store.ensureBucket().catch(() => {});
  return store;
}

main().catch((err) => {
  console.error("everdict-api failed to start:", err);
  process.exit(1);
});
