import { ImageRegistryService } from "@everdict/application-control";
import type { Metrics } from "@everdict/application-control";
import {
  type RecordingStore,
  RunnerHub,
  type RunnerHubLike,
  type RunnerJobStore,
  StoreRunnerHub,
} from "@everdict/application-control";
import { TraceSourceService } from "@everdict/application-control";
import type { BrowserProfileStore, WorkspaceImages } from "@everdict/application-control";
import {
  type BackendRegistry,
  type CaseRuntimeSample,
  type Dispatcher as CoreDispatcher,
  type Scheduler,
  buildRuntimeBackend,
  isCaseSampleable,
} from "@everdict/backends";
import { BadRequestError, type CaseJob, type RegistryAuth, type RuntimeSpec } from "@everdict/contracts";
import type { CallbackStore, RunnerStore, SecretCipher, SecretStore, WorkspaceSettingsStore } from "@everdict/db";
import type { TrustZonePolicy } from "@everdict/domain";
import { classifyFailure, isRunnerOnline } from "@everdict/domain";
import type { HarnessInstanceRegistry, ModelRegistry, RuntimeRegistry } from "@everdict/registry";
import { type EnvRecordSink, ServiceTopologyBackend, type ServiceTopologyBackendOptions } from "@everdict/topology";
import type { CaseRecorder } from "../common/case-recorder.js";
import type { LiveTraceStore } from "../common/live-trace-store.js";
import { makeProfileSeeder } from "../core/browser-profile/browser-profile-injector.js";
import { JudgeAuthDispatcher } from "../core/execution/judge-auth-dispatcher.js";
import { ModelResolvingDispatcher } from "../core/execution/model-resolving-dispatcher.js";
import { RuntimeDispatcher } from "../core/execution/runtime-dispatcher.js";
import { RuntimeSamplingDispatcher } from "../core/execution/runtime-sampling-dispatcher.js";
import { SelfHostedBackend } from "../core/execution/self-hosted-backend.js";
import { StoreCallbackRendezvous } from "../core/execution/store-callback-rendezvous.js";
import { buildTopologyEnvironment } from "../core/execution/topology-backend.js";
import { TraceRecordingDispatcher } from "../core/execution/trace-recording-dispatcher.js";
import { makeRuntimeController } from "../core/ops/runtime-control.js";
import { makeRuntimeInspector } from "../core/ops/runtime-inspect.js";
import { makeRuntimeProber } from "../core/ops/runtime-probe.js";
import { dockerRegistryReader } from "../infrastructure/registry/registry-reader.js";
import { buildImagePullAuths } from "./images.js";

// Dispatch stack: the self-hosted runner lease hub + the front-door callback rendezvous + tenant runtime routing
// (RuntimeSpec → live backend) + the one model-resolving/metered dispatcher every path shares + the connection probe.
export function buildDispatch(deps: {
  callbackStore: CallbackStore;
  secretStore: SecretStore;
  settingsStore: WorkspaceSettingsStore;
  harnessInstanceRegistry: HarnessInstanceRegistry;
  modelRegistry: ModelRegistry;
  runtimeRegistry: RuntimeRegistry;
  runnerStore: RunnerStore;
  runnerJobStore: RunnerJobStore;
  scheduler: Scheduler;
  backends: BackendRegistry;
  metrics: Metrics;
  browserProfileStore?: BrowserProfileStore; // browser-profiles S5 — resolve a referenced profile for eval injection
  // Managed image store (optional) — when present, a job's managed images are authorized with a minted grant
  // instead of a registered credential. docs/architecture/managed-image-store.md
  images?: WorkspaceImages;
  // Per-tenant isolation policy, when the operator configured one (composition/trust-zones.ts). Threaded into
  // BOTH dispatch lanes — the plain runtime backend and the topology one — because a control plane that
  // enforces isolation on one lane and not the other enforces it on neither.
  trustZones?: TrustZonePolicy;
  cipher?: SecretCipher; // browser-profiles S5 — decrypt the profile's captured storageState blob
  caseRecorder?: CaseRecorder; // replay ② — durable recorder the managed topology backend streams browser CDP events into
  // The attempt ledger the LEASE mints into (arch-review 41 P0-evidence). A self-hosted requeue re-leases the
  // same job to a second runner: that is a new physical execution, and it opens its own recording generation
  // here instead of appending into the row the abandoned attempt is still sealing.
  recordingStore?: RecordingStore;
  liveTraces?: LiveTraceStore; // observability ⑨ — the dispatch account's placement marks tee into the live-trace buffer
}) {
  const {
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
    browserProfileStore,
    cipher,
    caseRecorder,
    recordingStore,
    liveTraces,
  } = deps;
  // Saved-profile injection for browser evals (browser-profiles S5) — seed a referenced profile's login into the
  // per-case topology browser before the agent connects. Only when both the store + cipher are wired.
  const seedProfile =
    browserProfileStore && cipher ? makeProfileSeeder({ store: browserProfileStore, cipher }) : undefined;
  // Replay ② — the managed topology backend records the per-case browser's CDP events (network/console/nav + frames)
  // straight into the in-process CaseRecorder (→ RecordingStore), so a MANAGED browser-use run replays how its
  // environment evolved, not just the agent trace. recordTrack/recordFrame are best-effort (they swallow internally),
  // so firing-and-forgetting the promise is safe. Undefined when no recorder is wired (recording disabled).
  // …and it is handed the ATTEMPT the case was dispatched under (review 39, Phase 4). The recorder used to
  // hold that number in a process-local map, which is how a stale producer's evidence was re-labelled as its
  // successor's; every caller has it on the job now, so it travels as an argument.
  const recordSink = caseRecorder
    ? (runId: string, generation: number): EnvRecordSink => ({
        track: (item) => void caseRecorder.recordTrack(runId, item, generation),
        frame: (frameBase64) => void caseRecorder.recordFrame(runId, frameBase64, generation),
      })
    : undefined;
  // Self-hosted runner lease hub — parks self:<runnerId> jobs; the runner protocol (MCP, slice 4) leases/returns them.
  // A single instance shared by the dispatcher (park) and the MCP lease/result tools (lease/complete).
  // EVERDICT_RUNNER_MAX_QUEUE=N → backpressure: a runner/pool queue holding N waiting jobs rejects further parks with
  // RateLimitError(429) (self-hosted jobs bypass the Scheduler's queue-depth cap, so this is their bound). Default off.
  const maxRunnerQueue = Number(process.env.EVERDICT_RUNNER_MAX_QUEUE);
  const hubTimeout = {
    ...(process.env.EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS
      ? { queueTimeoutMs: Number(process.env.EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS) }
      : {}),
    ...(Number.isFinite(maxRunnerQueue) && maxRunnerQueue > 0 ? { maxWaitingPerKey: maxRunnerQueue } : {}),
  };
  // EVERDICT_SELF_HOSTED_STORE_HUB=1 → the store-backed hub (a job parked on one control-plane replica is leased +
  // completed from another via the shared Pg queue). Default = the in-memory hub (single-process, no polling).
  // A LEASE IS THE PHYSICAL ATTEMPT, so a re-lease opens its own recording generation (arch-review 41
  // P0-evidence). Only a re-lease mints — the first lease runs the job whose attempt the dispatch already
  // opened. A job with no runId has no recording to open; an open that fails leaves the re-leased job with no
  // generation at all, which the runner protocol degrades to the live-only lane rather than merging.
  const openAttempt = recordingStore
    ? async (job: CaseJob): Promise<number | undefined> =>
        job.runId === undefined ? undefined : await recordingStore.open(job.runId).catch(() => undefined)
    : undefined;
  const hubDeps = { ...hubTimeout, ...(openAttempt ? { openAttempt } : {}) };
  const runnerHub: RunnerHubLike =
    process.env.EVERDICT_SELF_HOSTED_STORE_HUB === "1"
      ? new StoreRunnerHub(runnerJobStore, hubDeps)
      : new RunnerHub(hubDeps);

  // Front-door callback completion model: when a public base URL is set, build one in-process rendezvous shared by the topology
  // backend (outbound: {{callback_url}}/wait) and the /frontdoor-callback route (inbound: deliver). If unset, the callback model
  // fails clearly in the driver (no rendezvous). Assumes a single control-plane process (in-process dispatch) — distribution via a store-backed rendezvous is a follow-up.
  // Store-backed rendezvous: the inbound POST may land on ANY replica — deliver persists to the shared store and
  // the driving replica's wait claims it (Pg store when DATABASE_URL is set; in-memory store = the single-process
  // dev shape, equivalent to the old in-process rendezvous).
  const callbackRendezvous = process.env.EVERDICT_CALLBACK_BASE_URL
    ? new StoreCallbackRendezvous(process.env.EVERDICT_CALLBACK_BASE_URL, callbackStore)
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
    reader: dockerRegistryReader(), // Docker Registry v2 read adapter — the agent's list_image_tags / inspect_image tools
  });
  // Workspace trace-source resolution for the topology pull — a service harness's selected source (name → config with the
  // auth value + correlate + scope) so a dev-cluster-deployed harness's trace is pulled from its team's platform after a case.
  // Image pull credentials — managed grants + BYO registries, defined ONCE so run, scorecard and the runtime
  // dispatcher all authorize a job's images the same way.
  const registryAuthsFor = buildImagePullAuths({
    ...(deps.images ? { images: deps.images } : {}),
    imageRegistry: imageRegistryService,
  });
  const traceSourceForDispatch = new TraceSourceService(settingsStore, { secretsFor: runtimeSecretsFor });
  // The shared topology ENVIRONMENT memo, keyed exactly like the RuntimeDispatcher's backend cache
  // (rt:<tenant>:<id>@<version>). One entry = one live TopologyRuntime (+ trace/rendezvous seams) — the eval
  // lane's ServiceTopologyBackend and the front-door conversation lane both build from it, so a tenant runtime
  // has ONE warm pool and one idle sweeper (two runtime instances would let one lane's sweeper tear down the
  // other lane's warm job mid-turn). Invalidated with the backend cache on a secret change.
  const topologyEnvs = new Map<string, ServiceTopologyBackendOptions>();
  const topologyEnvironmentFor = (
    tenant: string,
    spec: Extract<RuntimeSpec, { kind: "nomad" | "k8s" }>,
    opts: { secretEnv?: Record<string, string>; registryAuths?: RegistryAuth[] },
  ): ServiceTopologyBackendOptions => {
    const key = `rt:${tenant}:${spec.id}@${spec.version}`;
    const hit = topologyEnvs.get(key);
    if (hit) return hit;
    const env = buildTopologyEnvironment(spec, {
      harnesses: harnessInstanceRegistry,
      ...(callbackRendezvous ? { callbackRendezvous } : {}),
      // Image pull credentials — the topology runtime authenticates when pulling service images (nomad auth / k8s
      // imagePullSecrets). Baked at FIRST build and reused (the same documented limit the backend cache has).
      ...(opts.registryAuths ? { registryAuths: opts.registryAuths } : {}),
      // Resolved tenant secrets — for the runtime traceSource's authSecret (G1, langfuse/authenticated endpoints).
      ...(opts.secretEnv ? { secretEnv: opts.secretEnv } : {}),
      // Per-dispatch: the harness's selected workspace trace source (pull from the dev-cluster observability platform).
      resolveTraceSource: (t, harnessId) => traceSourceForDispatch.resolve(t, harnessId),
      // Browser-profiles S5 — seed a referenced saved profile's login into the per-case eval browser.
      ...(seedProfile ? { seedProfile } : {}),
      // Replay ② — stream the per-case browser's CDP events into the durable recording (managed path).
      ...(recordSink ? { recordSink } : {}),
      ...(deps.trustZones ? { trustZones: deps.trustZones } : {}),
    });
    topologyEnvs.set(key, env);
    return env;
  };
  // RuntimeSpec → live backend. nomad/k8s with a traceSource (= topology-capable) → ServiceTopologyBackend,
  // everything else → buildRuntimeBackend (local/nomad/k8s). (The old topology kind was folded into nomad/k8s + traceSource in slice 5b-2.)
  // Defined in one place so dispatch and the connection test (probe) share the same builder/auth path.
  const runtimeBuildBackend = (
    spec: RuntimeSpec,
    opts: {
      secretEnv?: Record<string, string>;
      registryAuths?: RegistryAuth[];
      tenant?: string;
      // What the JOB is, when the caller knows (see `jobFlavour`). A topology-capable runtime also runs plain
      // process jobs — a co-located code judge is one — and handing those to the topology deployer made them
      // fail as "harness instance not found". `undefined` = the caller has no job (the connection probe), so
      // the runtime's own shape decides, exactly as before.
      flavour?: "service" | "process";
    },
  ) =>
    (spec.kind === "nomad" || spec.kind === "k8s") && spec.traceSource && opts.flavour !== "process"
      ? new ServiceTopologyBackend(topologyEnvironmentFor(opts.tenant ?? "default", spec, opts))
      : buildRuntimeBackend(spec, { ...opts, ...(deps.trustZones ? { trustZones: deps.trustZones } : {}) });
  // The front-door conversation lane's entry to the SAME shared environment: tenant runtime ref → the memoized
  // topology environment (built here when the eval lane hasn't yet). `imageRefs` = the booting harness's service
  // images, so a conversation-initiated first build can still mint pull credentials.
  const topologyConversationEnvironmentFor = async (
    tenant: string,
    runtimeId: string,
    imageRefs: string[],
  ): Promise<ServiceTopologyBackendOptions> => {
    const spec = await runtimeRegistry.get(tenant, runtimeId, "latest");
    if (!(spec.kind === "nomad" || spec.kind === "k8s") || !spec.traceSource)
      throw new BadRequestError(
        "BAD_REQUEST",
        { runtime: runtimeId, kind: spec.kind },
        "The topology backend requires a traceSource setting (this runtime is not topology-capable).",
      );
    const key = `rt:${tenant}:${spec.id}@${spec.version}`;
    const hit = topologyEnvs.get(key);
    if (hit) return hit;
    const secretEnv = await runtimeSecretsFor(tenant).catch(() => ({}) as Record<string, string>);
    const registryAuths = (await registryAuthsFor(tenant, imageRefs).catch(() => [])) ?? [];
    return topologyEnvironmentFor(tenant, spec, {
      secretEnv,
      ...(registryAuths.length > 0 ? { registryAuths } : {}),
    });
  };
  // Resolve a command harness's {{model}} to a registered Model id (else raw), then delegate to RuntimeDispatcher (placement).
  // run/judge/scorecard share this one dispatcher, so every path runs with the identically-resolved model.
  const runtimeDispatcher = new RuntimeDispatcher({
    inner: scheduler,
    backends,
    runtimes: runtimeRegistry,
    secretsFor: runtimeSecretsFor,
    buildBackend: runtimeBuildBackend,
    // Image pull credentials — carried into the topology backend build to authenticate service-image pulls.
    registryAuthsFor,
    // self:<runnerId> — personally-owned runner. Confirm ownership (not owned = undefined) + return its liveness
    // (advertised capabilities for the service gate + whether it's online now for the "runner offline" diagnostic).
    resolveSelfRunner: async (owner, runnerId) => {
      const r = await runnerStore.get(owner, runnerId);
      return r
        ? { capabilities: r.capabilities ?? [], online: isRunnerOnline(r.lastSeenAt, Date.now()), label: r.label }
        : undefined;
    },
    // self:ws / self — pool. The liveness of every runner in that owner's pool: empty = no runner (404); the
    // capability sets drive the satisfiability gate; `online` drives the "all capable runners offline" diagnostic.
    poolRunners: async (owner) =>
      (await runnerStore.list(owner)).map((r) => ({
        capabilities: r.capabilities ?? [],
        online: isRunnerOnline(r.lastSeenAt, Date.now()),
        label: r.label,
      })),
    // Park ceiling: the Scheduler admits at most `capacity().total` concurrent parks per pool backend, and
    // the default ceiling (8) is BELOW any useful EVERDICT_RUNNER_MAX_QUEUE — the hub would then never hold
    // enough waiting jobs to reach the cap, and the overflow would pile up unbounded (and uncapped: self-hosted
    // is exempt from the Scheduler's queue-depth backpressure) in the Scheduler queue instead. When the runner
    // queue cap is configured, raise the park ceiling past it (cap + lease headroom) so the hub actually sees
    // the flood and sheds with the explicit queue-full 429 the knob promises.
    buildSelfHostedBackend: (key) =>
      new SelfHostedBackend(
        key,
        runnerHub,
        Number.isFinite(maxRunnerQueue) && maxRunnerQueue > 0 ? maxRunnerQueue + 64 : undefined,
      ),
  });
  // Judge provider key resolved per job (workspace tier → submitter personal fallback; fail-fast when a judge
  // is configured with no resolvable key on a managed target). MUST wrap OUTSIDE RuntimeDispatcher — it keys off
  // the ORIGINAL placement.target (self:* exemption) before the target is rewritten to a backend name.
  const judgeAuthDispatcher = new JudgeAuthDispatcher({
    inner: runtimeDispatcher,
    scopedSecretsFor,
    models: modelRegistry,
  });
  // scopedSecretsFor: a harness Model binding injects its baseUrl + underlying model + API key (from the model's
  // apiKeySecret, workspace→personal tiers) into the agent server's env — the same secret seam the judge uses.
  const resolvingDispatcher = new ModelResolvingDispatcher(modelRegistry, judgeAuthDispatcher, scopedSecretsFor);
  // Replay ③ — the RUNTIME plane's producer: while a managed dispatch is in flight, poll the case's orchestrator
  // resource stats (CaseSampleable — Nomad's client stats API) and stream the samples onto the recording's
  // `runtime` lane. Resolves the SAME tenant-runtime build/auth path dispatch uses; a target whose backend cannot
  // sample (topology/k8s/local) simply produces nothing. Sits outside RuntimeDispatcher for the same reason the
  // trace recorder does: it needs the user-chosen target name the record carries.
  const sampleCaseRuntime = async (
    tenant: string,
    targetList: string,
    caseId: string,
  ): Promise<CaseRuntimeSample | undefined> => {
    const targets = targetList
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "" && !t.startsWith("self:"));
    for (const target of targets) {
      const spec = await runtimeRegistry.get(tenant, target).catch(() => undefined);
      if (!spec) continue;
      const secretEnv = await runtimeSecretsFor(tenant).catch(() => ({}) as Record<string, string>);
      const backend = runtimeBuildBackend(spec, { secretEnv, tenant });
      if (!isCaseSampleable(backend)) continue;
      const sample = await backend.sampleCase(caseId).catch(() => undefined);
      if (sample) return sample;
    }
    return undefined;
  };
  const samplingDispatcher = caseRecorder
    ? new RuntimeSamplingDispatcher(resolvingDispatcher, {
        sample: sampleCaseRuntime,
        record: (runId, item, generation) => void caseRecorder.recordTrack(runId, item, generation),
      })
    : resolvingDispatcher;
  // Control-plane infra-plane recording — the OUTERMOST decorator, so the sealed trajectory's account starts at
  // "the control plane accepted this case → target X" and carries queue wait + waiting diagnostics before the
  // backend's own events. Sits outside ModelResolving/RuntimeDispatcher to see the user-chosen target name.
  const dispatcher = new TraceRecordingDispatcher(samplingDispatcher, liveTraces);
  // Workspace secrets feed the cached runtime backends' secretEnv — a secret change must drop that tenant's
  // cache so the next dispatch rebuilds with fresh values (previously only a CP restart picked them up).
  const invalidateTenantBackends = (tenant: string) => {
    runtimeDispatcher.invalidateTenant(tenant);
    // The shared topology environments carry the same baked secrets — drop them with the backends. Live
    // conversations keep their captured runtime reference (they finish on the old credentials, like the eval
    // lane's in-flight dispatches); the next boot rebuilds fresh.
    const prefix = `rt:${tenant}:`;
    for (const key of topologyEnvs.keys()) if (key.startsWith(prefix)) topologyEnvs.delete(key);
  };
  // Drop a revoked runner's lazily-registered self:<owner>:<runnerId> backend so runner churn (pair→run→revoke)
  // doesn't leak one Backend per runner in the placement registry. Wired to RunnerService.onRevoke in main.ts.
  const releaseSelfRunnerBackend = (owner: string, runnerId: string) =>
    runtimeDispatcher.unregisterSelfRunnerBackend(owner, runnerId);
  // Metered dispatcher — every dispatch (single runs, batch cases, judges) flows through one seam, so outcome
  // counters and the per-runtime duration histogram cover the whole system without per-caller wiring.
  const meteredDispatcher: CoreDispatcher = {
    dispatch: async (job, opts) => {
      const runtime = job.evalCase.placement?.target ?? "default";
      const startedAt = Date.now();
      try {
        const result = await dispatcher.dispatch(job, opts);
        metrics.counter("everdict_dispatch_total", "Dispatch outcomes.", { runtime, outcome: "ok" });
        metrics.observe(
          "everdict_case_duration_seconds",
          "Case wall-clock from dispatch to result, per runtime.",
          { runtime },
          (Date.now() - startedAt) / 1000,
        );
        return result;
      } catch (err) {
        metrics.counter("everdict_dispatch_total", "Dispatch outcomes.", {
          runtime,
          outcome: classifyFailure(err, "dispatch").class,
        });
        throw err;
      }
    },
  };
  // Connection test / live inspection / destructive control all target the BASE cluster (nomad/k8s reachability,
  // nodes/capacity/workload, stop/purge/cordon) — NOT the topology-deploy layer. So they build the base backend
  // (buildRuntimeBackend → NomadBackend/K8sBackend, which are Probeable/Inspectable/Reclaimable), NOT runtimeBuildBackend:
  // a topology-configured runtime (nomad/k8s + traceSource) would otherwise route to ServiceTopologyBackend, which
  // implements none of those capabilities → probe/inspect/control would falsely report "not supported / no live cluster".
  const probeRuntime = makeRuntimeProber({ secretsFor: runtimeSecretsFor, buildBackend: buildRuntimeBackend });
  const inspectRuntime = makeRuntimeInspector({ secretsFor: runtimeSecretsFor, buildBackend: buildRuntimeBackend });
  const controlRuntime = makeRuntimeController({ secretsFor: runtimeSecretsFor, buildBackend: buildRuntimeBackend });
  return {
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
  };
}
