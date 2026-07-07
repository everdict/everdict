# Nomad co-located service topology

**Scope: the Nomad `TopologyRuntime` only.** K8s (stable Service DNS) and Docker (already co-located on one
network) are unchanged. Stores (`dependencies[]`) are out of scope and keep their current model.

## The problem — dynamic host ports + per-service groups = stale addresses on reschedule

The old `buildNomadTopologyJob` rendered **one task group per service**. Each group has its own network
namespace, and a service with a `port` got a **dynamic host port** (label `http`) mapped by the docker driver.
Because every service lived in a different netns, the only way for one service to reach another (a `needs` edge)
or for the control plane to reach the front-door was through that dynamically-assigned `host:port`.

Dynamic host ports are assigned per alloc. When Nomad **reschedules** a group (node drain, alloc failure,
bin-packing), the new alloc gets a **new** host port — but any address that resolved the old one is now stale.
Since each service is an independent group, a downstream service can reschedule on its own while the front-door
stays put, so the front-door's cached address for that downstream points at a dead port → `fetch failed`, and the
warm topology is intermittently broken. This is inherent to routing intra-topology traffic over dynamic host
ports across separate netns.

The Docker runtime never had this problem: all services share **one network**, each reachable at a **stable
internal address** (`<svc.name>:<fixed container port>`) that does not depend on any host-port assignment.

## The model — co-locate every service in one task group (shared netns), loopback comms

`buildNomadTopologyJob` now renders **one task group** (`SERVICE_GROUP_NAME = "everdict-services"`) containing
**one task per service**, on a **bridge** network — so all services share a single network namespace:

- **Inter-service traffic is loopback.** A peer is reached at `localhost:<svc.port>`. `svc.port` is fixed in the
  spec, so the address never changes on reschedule. `extra_hosts` additionally maps every service **name** →
  `127.0.0.1`, so a harness that addresses a peer by `<svc.name>:<port>` (the docker/k8s convention) resolves to
  loopback too — **one harness definition, identical wiring across docker / k8s / nomad**.
- **The whole topology reschedules atomically.** One group = one alloc, so there is no partial reschedule where a
  downstream drifts while its caller is unaware. When the alloc moves, every service moves together and their
  loopback addresses are unchanged.
- **The control plane still reaches services via a group dynamic host port.** Each ported service gets a group
  dynamic port labeled by its (sanitized) name, mapped `To` its fixed container port. The runtime waits for the
  single group's alloc **once** and resolves each service's `host:port` by its label
  (`resolvePort(alloc, servicePortLabel(svc.name))`). `handle.endpoints` is unchanged in shape.

### Constraint — unique ports

A shared netns means a port can be bound by only one service (separate netns per service previously allowed
reuse). `buildNomadTopologyJob` **throws `BadRequestError`** if two services declare the same `port`. Most
topologies already use distinct ports (front-door 8000, mcp 9000, …); this makes the requirement explicit.

### Limitation — per-service replicas

The group's `Count` is `1` (one instance of the whole topology). Per-service `replicas > 1` is not meaningful in
a shared netns (two tasks can't bind the same port) and is ignored; horizontal scale-out of a co-located
topology is a follow-up.

## Tenant isolation — unchanged guarantees, simpler mechanism

Cross-tenant network isolation is still the **per-`(spec, version, zone)` job / Nomad namespace / netns
separation**: the warm pool is keyed by `(spec, version, zone.id)`, the job ID carries the zone, and each zone
uses its own namespace. A tenant's co-located alloc has **no route** to another tenant's alloc. **One tenant's
services sharing one netns is intra-tenant and not a cross-tenant concern** — it is the same trust domain.

## Consul Connect — obviated for inter-service, retained as the cross-tenant decision

The previous model put each service on the Consul Connect mesh (Envoy sidecar + `bridge` + upstreams) so that
`service-intentions` (allow same-tenant, deny `*`) could govern who talks to whom. With co-location there is **no
inter-service mesh hop** — peers talk over loopback in the same netns — so the per-service sidecar/upstream wiring
is **removed** from `buildNomadTopologyJob` (and the `connect` builder option is gone). The runtime never enabled
it for real topologies, so there is no behavior regression.

What remains, deliberately:

- `buildConnectService` / `NomadConnectService` — a standalone building block still used by the live enforcement
  proof (`scripts/live/connect-enforce-nomad.mjs`).
- `buildTenantIntentions` / `buildSharedStoreIntention` (`consul-intentions.ts`) — still applied by
  `NomadTopologyRuntime.ensureTopology` when a `ConsulClient` is injected. They are now the cross-tenant
  **authorization decision** (defense-in-depth, and the policy for a Connect-enabled external front-door gateway
  if an operator runs one), not the inter-service data plane.

## Files

- `packages/topology/src/nomad-topology.ts` — `buildNomadTopologyJob` (co-located group), `SERVICE_GROUP_NAME`,
  `servicePortLabel`.
- `packages/topology/src/nomad-runtime.ts` — `ensureTopology` discovers all ports from the one co-located alloc.
- Tests: `topology.test.ts` (builder shape, extra_hosts, unique-port), `nomad-runtime.test.ts` (single-alloc
  discovery regression).
