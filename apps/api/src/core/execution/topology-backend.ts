import type { Backend } from "@everdict/backends";
import {
  BadRequestError,
  type CaseJob,
  type RegistryAuth,
  type RuntimeSpec,
  type TraceSourceConfig,
} from "@everdict/contracts";
import type { HarnessInstanceRegistry } from "@everdict/registry";
import {
  type CallbackRendezvous,
  K8sTopologyRuntime,
  NomadTopologyRuntime,
  ServiceTopologyBackend,
  type TopologyRuntime,
} from "@everdict/topology";
import { buildTraceSource } from "@everdict/trace";

// topology-capable nomad/k8s RuntimeSpec → ServiceTopologyBackend (Backend). @everdict/backends can't depend on @everdict/topology
// (cycle), so this wiring lives in apps/api, which depends on both. When we encounter a nomad/k8s runtime that has a traceSource
// (in place of the old topology kind — slice 5b-2), build the backend with this and put it in the Scheduler registry.
// The orchestrator is now implied by the runtime kind (nomad|k8s). Cluster startup is live (the tenant's Nomad/K8s + browser-use image).
export function buildTopologyBackend(
  spec: Extract<RuntimeSpec, { kind: "nomad" | "k8s" }>,
  deps: {
    harnesses: HarnessInstanceRegistry;
    callbackRendezvous?: CallbackRendezvous;
    // Workspace image-registry pull credentials (resolved at build time) — for authenticated service-image pulls
    // (nomad docker auth / k8s dockerconfigjson Secret + imagePullSecrets).
    registryAuth?: RegistryAuth;
    // Per-dispatch resolver for the harness's selected WORKSPACE-registered trace source (TraceSourceService.resolve:
    // name → config with the auth value + correlate + scope). When it yields a config, the pull uses that source
    // (a dev-cluster observability endpoint) instead of the fixed runtime traceSource; undefined = fall back.
    resolveTraceSource?: (tenant: string, harnessId: string) => Promise<TraceSourceConfig | undefined>;
    // Resolved tenant secrets (SecretStore.entries) — used to resolve the runtime traceSource's authSecret (G1).
    secretEnv?: Record<string, string>;
    // Saved-profile injection (browser-profiles S5) — seed a referenced profile's login into the per-case browser
    // before the agent connects. Built in the composition (BrowserProfileStore + cipher); undefined = no injection.
    seedProfile?: (profileId: string, cdpBase: string, job: CaseJob) => Promise<void>;
  },
): Backend {
  const ts = spec.traceSource;
  if (!ts) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { runtime: spec.id, kind: spec.kind },
      "The topology backend requires a traceSource setting (this runtime is not topology-capable).",
    );
  }
  const runtime: TopologyRuntime =
    spec.kind === "nomad"
      ? new NomadTopologyRuntime({
          addr: spec.addr,
          ...(spec.namespace ? { namespace: spec.namespace } : {}),
          ...(spec.browserImage ? { browserImage: spec.browserImage } : {}),
          ...(deps.registryAuth ? { registryAuth: deps.registryAuth } : {}),
        })
      : new K8sTopologyRuntime({
          ...(spec.context ? { context: spec.context } : {}),
          ...(spec.namespace ? { namespacePrefix: spec.namespace } : {}),
          ...(spec.browserImage ? { browserImage: spec.browserImage } : {}),
          ...(deps.registryAuth ? { registryAuth: deps.registryAuth } : {}),
        });
  // Build the full fixed source from the runtime spec (G1: 5 kinds + auth/correlate/scope). authSecret → the verbatim
  // auth-header value from the tenant SecretStore; otel/mlflow read it from headers.authorization and the newer three
  // inherit it as `auth` (buildTraceSource), so the single headers.authorization mapping covers all five kinds.
  const tsAuth = ts.authSecret ? deps.secretEnv?.[ts.authSecret] : undefined;
  const traceSource = buildTraceSource({
    kind: ts.kind,
    endpoint: ts.endpoint,
    ...(tsAuth ? { headers: { authorization: tsAuth } } : {}),
    ...(ts.correlate ? { correlate: ts.correlate } : {}),
    ...(ts.service ? { service: ts.service } : {}),
    ...(ts.project ? { project: ts.project } : {}),
  });
  // Resolve the harness's selected workspace source per-dispatch → build a full TraceSource (auth/correlate/scope).
  const resolve = deps.resolveTraceSource;
  const traceSourceFor = resolve
    ? async (tenant: string, harnessId: string) => {
        const cfg = await resolve(tenant, harnessId);
        return cfg ? buildTraceSource(cfg) : undefined;
      }
    : undefined;
  return new ServiceTopologyBackend({
    runtime,
    traceSource,
    ...(traceSourceFor ? { traceSourceFor } : {}),
    // Rendezvous for the callback completion model (if present) — issues {{callback_url}} + awaits inbound. The control-plane route delivers to the same instance.
    ...(deps.callbackRendezvous ? { callbackRendezvous: deps.callbackRendezvous } : {}),
    ...(deps.seedProfile ? { seedProfile: deps.seedProfile } : {}), // browser-profiles S5 — inject a saved login into the eval browser
    // The topology shape (services/dependencies/target) comes from the harness (kind:"service"). Reject if it's not a service harness.
    specFor: async (tenant, id, version) => {
      const h = await deps.harnesses.get(tenant, id, version);
      if (h.kind !== "service") {
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: id, kind: h.kind },
          "The topology runtime requires a kind:service harness.",
        );
      }
      return h;
    },
  });
}
