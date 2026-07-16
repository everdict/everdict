import { ImageRegistryService } from "@everdict/application-control";
import type { Metrics } from "@everdict/application-control";
import { RunnerHub, type RunnerHubLike, type RunnerJobStore, StoreRunnerHub } from "@everdict/application-control";
import { TraceSourceService } from "@everdict/application-control";
import {
  type BackendRegistry,
  type Dispatcher as CoreDispatcher,
  type Scheduler,
  buildRuntimeBackend,
} from "@everdict/backends";
import type { RegistryAuth, RuntimeSpec } from "@everdict/contracts";
import type { CallbackStore, RunnerStore, SecretStore, WorkspaceSettingsStore } from "@everdict/db";
import { classifyFailure } from "@everdict/domain";
import type { HarnessInstanceRegistry, ModelRegistry, RuntimeRegistry } from "@everdict/registry";
import { JudgeAuthDispatcher } from "../core/execution/judge-auth-dispatcher.js";
import { ModelResolvingDispatcher } from "../core/execution/model-resolving-dispatcher.js";
import { RuntimeDispatcher } from "../core/execution/runtime-dispatcher.js";
import { SelfHostedBackend } from "../core/execution/self-hosted-backend.js";
import { StoreCallbackRendezvous } from "../core/execution/store-callback-rendezvous.js";
import { buildTopologyBackend } from "../core/execution/topology-backend.js";
import { makeRuntimeController } from "../core/ops/runtime-control.js";
import { makeRuntimeInspector } from "../core/ops/runtime-inspect.js";
import { makeRuntimeProber } from "../core/ops/runtime-probe.js";

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
  } = deps;
  // Self-hosted runner lease hub — parks self:<runnerId> jobs; the runner protocol (MCP, slice 4) leases/returns them.
  // A single instance shared by the dispatcher (park) and the MCP lease/result tools (lease/complete).
  const hubTimeout = process.env.EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS
    ? { queueTimeoutMs: Number(process.env.EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS) }
    : {};
  // EVERDICT_SELF_HOSTED_STORE_HUB=1 → the store-backed hub (a job parked on one control-plane replica is leased +
  // completed from another via the shared Pg queue). Default = the in-memory hub (single-process, no polling).
  const runnerHub: RunnerHubLike =
    process.env.EVERDICT_SELF_HOSTED_STORE_HUB === "1"
      ? new StoreRunnerHub(runnerJobStore, hubTimeout)
      : new RunnerHub(hubTimeout);

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
  });
  // Workspace trace-source resolution for the topology pull — a service harness's selected source (name → config with the
  // auth value + correlate + scope) so a dev-cluster-deployed harness's trace is pulled from its team's platform after a case.
  const traceSourceForDispatch = new TraceSourceService(settingsStore, { secretsFor: runtimeSecretsFor });
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
          // Resolved tenant secrets — for the runtime traceSource's authSecret (G1, langfuse/authenticated endpoints).
          ...(opts.secretEnv ? { secretEnv: opts.secretEnv } : {}),
          // Per-dispatch: the harness's selected workspace trace source (pull from the dev-cluster observability platform).
          resolveTraceSource: (tenant, harnessId) => traceSourceForDispatch.resolve(tenant, harnessId),
        })
      : buildRuntimeBackend(spec, opts);
  // Resolve a command harness's {{model}} to a registered Model id (else raw), then delegate to RuntimeDispatcher (placement).
  // run/judge/scorecard share this one dispatcher, so every path runs with the identically-resolved model.
  const runtimeDispatcher = new RuntimeDispatcher({
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
  const dispatcher = new ModelResolvingDispatcher(modelRegistry, judgeAuthDispatcher, scopedSecretsFor);
  // Workspace secrets feed the cached runtime backends' secretEnv — a secret change must drop that tenant's
  // cache so the next dispatch rebuilds with fresh values (previously only a CP restart picked them up).
  const invalidateTenantBackends = (tenant: string) => runtimeDispatcher.invalidateTenant(tenant);
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
    runtimeBuildBackend,
    dispatcher,
    meteredDispatcher,
    probeRuntime,
    inspectRuntime,
    controlRuntime,
    invalidateTenantBackends,
  };
}
