import { ImageRegistryService } from "@everdict/application-control";
import type { Metrics } from "@everdict/application-control";
import { RunnerHub } from "@everdict/application-control";
import {
  type BackendRegistry,
  type Dispatcher as CoreDispatcher,
  type Scheduler,
  buildRuntimeBackend,
} from "@everdict/backends";
import { type RegistryAuth, type RuntimeSpec, classifyFailure } from "@everdict/core";
import type { CallbackStore, RunnerStore, SecretStore, WorkspaceSettingsStore } from "@everdict/db";
import type { HarnessInstanceRegistry, ModelRegistry, RuntimeRegistry } from "@everdict/registry";
import { ModelResolvingDispatcher } from "../core/execution/model-resolving-dispatcher.js";
import { RuntimeDispatcher } from "../core/execution/runtime-dispatcher.js";
import { SelfHostedBackend } from "../core/execution/self-hosted-backend.js";
import { StoreCallbackRendezvous } from "../core/execution/store-callback-rendezvous.js";
import { buildTopologyBackend } from "../core/execution/topology-backend.js";
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
    scheduler,
    backends,
    metrics,
  } = deps;
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
  // Connection test: build a backend with the same builder + tenant secrets and probe() (reachability/auth with no job). Shared by server/MCP.
  const probeRuntime = makeRuntimeProber({ secretsFor: runtimeSecretsFor, buildBackend: runtimeBuildBackend });
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
  };
}
