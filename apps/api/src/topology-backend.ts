import type { Backend } from "@everdict/backends";
import { BadRequestError, type RegistryAuth, type RuntimeSpec } from "@everdict/core";
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
  const traceSource = buildTraceSource({ kind: ts.kind, endpoint: ts.endpoint });
  return new ServiceTopologyBackend({
    runtime,
    traceSource,
    // Rendezvous for the callback completion model (if present) — issues {{callback_url}} + awaits inbound. The control-plane route delivers to the same instance.
    ...(deps.callbackRendezvous ? { callbackRendezvous: deps.callbackRendezvous } : {}),
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
