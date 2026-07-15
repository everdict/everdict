import { UpstreamError } from "@everdict/contracts";

// A resolved service endpoint never responded within its readiness budget. On a topology, readiness polling doubles as
// the control-plane-side REACHABILITY contract check — a timeout means either a slow boot OR that the runtime resolved
// an address the control plane cannot route to on this backend (the "works on the self-hosted runner, fails on
// Nomad/K8s" failure surfaced concretely, not as a bare "not ready"). One message across all three runtimes so the
// failure reads the same everywhere. docs/architecture/topology-portability.md (L4 — reachability preflight).
export function endpointUnreachableError(url: string): UpstreamError {
  return new UpstreamError(
    "UPSTREAM_ERROR",
    { url },
    `The service endpoint ${url} never became reachable within its readiness budget — the control plane cannot reach it on this runtime (a slow boot, or an address that is not routable here).`,
  );
}
