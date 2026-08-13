import type { TraceSourceSpec } from "../harness/harness-spec.js";

// ── A SPEC CROSSING A BOUNDARY ARRIVES WHOLE ─────────────────────────────────────────────────────────
//
// Every transport here used to be a hand-written object literal at the call site, and every receiving option
// type is all-optional — so a field added to a spec and forgotten at the boundary compiles, ships, and is
// discovered as behaviour: a Nomad cluster with no `datacenters` defaults to `["dc1"]` and has no eligible
// node ever; a trace source with no `mapping` loses the judge's evidence slots and every span override.
// Four such drops were found at once, in four literals, which is the shape of a missing invariant rather
// than four mistakes.
//
// These are the named total transfers. They live here because both halves of each boundary sit below the
// domain cone (an adapter builds the options, another adapter consumes them) and the decision is pure: no
// I/O, no store, total over its input — the admission test for this package.
//
// NOT a spread. `authSecret` is a SecretStore *name*, and the resolved value is what the transport carries;
// `{...spec}` would put the name in a config object and eventually in a log. Each field is named, and the
// conformance test asserts that a fully-populated spec arrives fully populated — so the next field added to a
// spec fails here rather than in a cluster.

// The topology-relevant half of a runtime spec, structurally. Declared rather than imported so this stays
// free of the orchestrator packages (which sit above contracts).
export interface TopologyRuntimeTransport {
  namespace?: string;
  browserImage?: string;
  hostGatewayAddr?: string;
  datacenters?: string[];
  runtime?: string;
  provisionDependencies?: boolean;
}

// RuntimeSpec(nomad) → the options a topology runtime is constructed with. `addr` and the caller's own
// concerns (registryAuths, http, exec) stay the caller's; everything the SPEC can say arrives here.
export function nomadTopologyTransport(spec: {
  namespace?: string;
  browserImage?: string;
  hostGatewayAddr?: string;
  datacenters?: string[];
  runtime?: string;
  provisionDependencies?: boolean;
}): TopologyRuntimeTransport {
  return {
    ...(spec.namespace !== undefined ? { namespace: spec.namespace } : {}),
    ...(spec.browserImage !== undefined ? { browserImage: spec.browserImage } : {}),
    ...(spec.hostGatewayAddr !== undefined ? { hostGatewayAddr: spec.hostGatewayAddr } : {}),
    // Without these two the cluster answers with silence rather than an error: no datacenters → Nomad's own
    // default `["dc1"]` → a cluster named anything else has no eligible node, forever; no
    // provisionDependencies → a zone-less topology comes up without the stores it declared.
    ...(spec.datacenters !== undefined ? { datacenters: spec.datacenters } : {}),
    ...(spec.runtime !== undefined ? { runtime: spec.runtime } : {}),
    ...(spec.provisionDependencies !== undefined ? { provisionDependencies: spec.provisionDependencies } : {}),
  };
}

// RuntimeSpec(k8s) → the same, minus what K8s has no notion of (datacenters) and with its own naming.
export function k8sTopologyTransport(spec: {
  namespace?: string;
  browserImage?: string;
  hostGatewayAddr?: string;
  provisionDependencies?: boolean;
}): { namespacePrefix?: string; browserImage?: string; hostGatewayAddr?: string; provisionDependencies?: boolean } {
  return {
    ...(spec.namespace !== undefined ? { namespacePrefix: spec.namespace } : {}),
    ...(spec.browserImage !== undefined ? { browserImage: spec.browserImage } : {}),
    ...(spec.hostGatewayAddr !== undefined ? { hostGatewayAddr: spec.hostGatewayAddr } : {}),
    ...(spec.provisionDependencies !== undefined ? { provisionDependencies: spec.provisionDependencies } : {}),
  };
}

// The trace source a runtime declares → the config its builder consumes. `auth` is the RESOLVED header value
// (the caller reads it from the SecretStore); `authSecret`, the name, must never appear in the result.
export function traceSourceTransport(
  spec: TraceSourceSpec,
  auth?: string,
): Omit<TraceSourceSpec, "authSecret"> & { headers?: Record<string, string> } {
  return {
    kind: spec.kind,
    endpoint: spec.endpoint,
    ...(auth ? { headers: { authorization: auth } } : {}),
    ...(spec.correlate !== undefined ? { correlate: spec.correlate } : {}),
    ...(spec.correlateTag !== undefined ? { correlateTag: spec.correlateTag } : {}),
    ...(spec.service !== undefined ? { service: spec.service } : {}),
    ...(spec.project !== undefined ? { project: spec.project } : {}),
    // The one that was missing, and the expensive one: `mapping` carries the span→TraceEvent overrides AND
    // the judge's evidence slots, so dropping it silently produced a harness whose judges grade on less
    // evidence than the trace holds — the same defect as an evidence field lost in transit, arriving by a
    // different road.
    ...(spec.mapping !== undefined ? { mapping: spec.mapping } : {}),
    ...(spec.artifactBaseUrl !== undefined ? { artifactBaseUrl: spec.artifactBaseUrl } : {}),
  };
}
