import type { TopologyService } from "@everdict/contracts";

// Peer address resolution — the SINGLE place a logical peer (a `needs` service) maps to its physical BUILD-TIME host,
// and the only spot that legitimately diverges per runtime. Pointing the call sites (docker-runtime, nomad-topology,
// k8s-topology) at these named strategies keeps the cross-runtime divergence auditable in one file; the parity test
// locks each form. Per-service Nomad resolves at RUNTIME via a consul-template render (a different mechanism, staying in
// nomad-topology's peerTemplateEnv). See docs/architecture/topology-portability.md.

// Docker network alias + co-located Nomad loopback: a peer is reachable by its plain service name (docker adds a
// `--network-alias` = svc.name; co-located Nomad maps svc.name → 127.0.0.1 via extra_hosts within the shared netns).
export function aliasPeerHost(peer: TopologyService): string {
  return peer.name;
}

// K8s Service DNS: each service gets a Service named `<harnessId>-<service>` — stable and cluster-internal — so a peer
// is reached by THAT name, not the plain service name (which is why a literal `<svc>:<port>` breaks on K8s but a
// `{{peer}}` token, rendered through here, does not).
export function k8sPeerHost(harnessId: string): (peer: TopologyService) => string {
  return (peer) => `${harnessId}-${peer.name}`;
}
