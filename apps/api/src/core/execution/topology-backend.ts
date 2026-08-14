import type { Backend } from "@everdict/backends";
import {
  BadRequestError,
  type CaseJob,
  type RegistryAuth,
  type RuntimeSpec,
  type TraceSourceConfig,
  k8sTopologyTransport,
  nomadTopologyTransport,
  traceSourceTransport,
} from "@everdict/contracts";
import type { TrustZonePolicy } from "@everdict/domain";
import type { HarnessInstanceRegistry } from "@everdict/registry";
import {
  type CallbackRendezvous,
  type EnvRecordSink,
  K8sTopologyRuntime,
  NomadTopologyRuntime,
  ServiceTopologyBackend,
  type ServiceTopologyBackendOptions,
  type TopologyRuntime,
} from "@everdict/topology";
import { buildTraceSource } from "@everdict/trace";

// topology-capable nomad/k8s RuntimeSpec → ServiceTopologyBackend (Backend). @everdict/backends can't depend on @everdict/topology
// (cycle), so this wiring lives in apps/api, which depends on both. When we encounter a nomad/k8s runtime that has a traceSource
// (in place of the old topology kind — slice 5b-2), build the backend with this and put it in the Scheduler registry.
// The orchestrator is now implied by the runtime kind (nomad|k8s). Cluster startup is live (the tenant's Nomad/K8s + browser-use image).
//
// Split in two: `buildTopologyEnvironment` yields the live TopologyRuntime + trace/rendezvous seams (the
// SHARED per-(tenant, runtime@version) environment — the front-door conversation lane holds the same
// instance, so both lanes share ONE warm pool and one idle sweeper), and `buildTopologyBackend` wraps it as
// the eval lane's Backend.
export function buildTopologyEnvironment(
  spec: Extract<RuntimeSpec, { kind: "nomad" | "k8s" }>,
  deps: {
    harnesses: HarnessInstanceRegistry;
    callbackRendezvous?: CallbackRendezvous;
    // Image pull credentials (resolved at build time) — for authenticated service-image pulls
    // (nomad docker auth / k8s dockerconfigjson Secret + imagePullSecrets). One entry per registry host.
    registryAuths?: RegistryAuth[];
    // Per-dispatch resolver for the harness's selected WORKSPACE-registered trace source (TraceSourceService.resolve:
    // name → config with the auth value + correlate + scope). When it yields a config, the pull uses that source
    // (a dev-cluster observability endpoint) instead of the fixed runtime traceSource; undefined = fall back.
    resolveTraceSource?: (tenant: string, harnessId: string) => Promise<TraceSourceConfig | undefined>;
    // Resolved tenant secrets (SecretStore.entries) — used to resolve the runtime traceSource's authSecret (G1).
    secretEnv?: Record<string, string>;
    // Saved-profile injection (browser-profiles S5) — seed a referenced profile's login into the per-case browser
    // before the agent connects. Built in the composition (BrowserProfileStore + cipher); undefined = no injection.
    seedProfile?: (profileId: string, cdpBase: string, job: CaseJob) => Promise<void>;
    // Replay environment plane (docs/architecture/replay.md ②) — a per-run sink the CDP recorder streams the browser's
    // network/console/nav (+ frames) into. For the managed backend this routes straight to the in-process CaseRecorder
    // (recordTrack/recordFrame → the durable RecordingStore). Undefined = no environment recording (trace-only replay).
    recordSink?: (runId: string, generation: number) => EnvRecordSink | undefined;
    // Per-tenant isolation, when the operator configured a policy: the topology's warm pool is keyed BY zone
    // (so two tenants never share a pool) and each service runs under the zone's runtime + namespace.
    trustZones?: TrustZonePolicy;
  },
): ServiceTopologyBackendOptions {
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
          // TRANSPORTED, not transcribed (downstream report 2.1). This literal listed fields by hand and had
          // silently stopped at three of them: no `datacenters` meant Nomad's own `["dc1"]` default and a
          // cluster named anything else had no eligible node, ever. The receiving options are all optional,
          // so nothing objected. `nomadTopologyTransport` is the named total transfer, and its conformance
          // test fails the day a spec grows a field this boundary does not forward.
          ...nomadTopologyTransport(spec),
          ...(deps.registryAuths ? { registryAuths: deps.registryAuths } : {}),
        })
      : new K8sTopologyRuntime({
          ...(spec.context ? { context: spec.context } : {}),
          ...k8sTopologyTransport(spec),
          ...(deps.registryAuths ? { registryAuths: deps.registryAuths } : {}),
        });
  // Build the full fixed source from the runtime spec (G1: 5 kinds + auth/correlate/scope). authSecret → the verbatim
  // auth-header value from the tenant SecretStore; otel/mlflow read it from headers.authorization and the newer three
  // inherit it as `auth` (buildTraceSource), so the single headers.authorization mapping covers all five kinds.
  // …and the same for the trace source, which had dropped `mapping` — the span overrides AND the judge's
  // evidence slots, so a harness's judges graded on less evidence than its trace held.
  const tsAuth = ts.authSecret ? deps.secretEnv?.[ts.authSecret] : undefined;
  const traceSource = buildTraceSource(traceSourceTransport(ts, tsAuth));
  // Resolve the harness's selected workspace source per-dispatch → build a full TraceSource (auth/correlate/scope).
  const resolve = deps.resolveTraceSource;
  const traceSourceFor = resolve
    ? async (tenant: string, harnessId: string) => {
        const cfg = await resolve(tenant, harnessId);
        return cfg ? buildTraceSource(cfg) : undefined;
      }
    : undefined;
  return {
    runtime,
    traceSource,
    // The runtime's declared slot cap (RuntimeSpec.maxConcurrent) — the topology lane used to drop it entirely,
    // so a tenant-declared ceiling (or a wider-than-default cap) never reached the Scheduler and the lane sat at
    // the backend's base 8 regardless. With a visible session pool it acts as the operator clamp over the pool.
    ...(spec.maxConcurrent !== undefined ? { maxConcurrent: spec.maxConcurrent } : {}),
    ...(deps.trustZones ? { trustZones: deps.trustZones } : {}),
    ...(traceSourceFor ? { traceSourceFor } : {}),
    // Rendezvous for the callback completion model (if present) — issues {{callback_url}} + awaits inbound. The control-plane route delivers to the same instance.
    ...(deps.callbackRendezvous ? { callbackRendezvous: deps.callbackRendezvous } : {}),
    ...(deps.seedProfile ? { seedProfile: deps.seedProfile } : {}), // browser-profiles S5 — inject a saved login into the eval browser
    ...(deps.recordSink ? { recordSink: deps.recordSink } : {}), // replay ② — stream the browser's CDP events into the recording
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
  };
}

export function buildTopologyBackend(
  spec: Extract<RuntimeSpec, { kind: "nomad" | "k8s" }>,
  deps: Parameters<typeof buildTopologyEnvironment>[1],
): Backend {
  return new ServiceTopologyBackend(buildTopologyEnvironment(spec, deps));
}
