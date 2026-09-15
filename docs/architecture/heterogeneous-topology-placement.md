---
kind: wiki
title: "Heterogeneous topology placement — infra-agnostic (capability-driven)"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/infra/capability.ts, packages/domain/src/runtime/capability-requirements.ts, packages/topology/src/deploy/nomad-topology.ts, packages/topology/src/deploy/k8s-topology.ts]
---
# Heterogeneous topology placement — infra-agnostic (capability-driven)

A `kind:"service"` topology may contain services that need different execution environments — a Windows
Playwright or UI-driver service next to Linux agent services — and a service may need more than one instance.
Neither may leak an orchestrator detail into the harness, because a registered harness has to run on any runtime:
a laptop's Docker, any Nomad, any K8s.

> **The harness declares WHAT each service needs (a capability) and addresses peers by name. WHERE and HOW they are
> placed, co-located, discovered across hosts and scaled is the `TopologyRuntime` adapter's business.** Nomad
> constraints and K8s `nodeSelector` live inside an adapter, never in the contract.

## The harness side — portable declarations only

On `TopologyService` (`packages/contracts/src/harness/harness-spec.ts`):

- `requires.os: linux | windows | macos` — what the service's image or program genuinely needs, on any infra. Unset
  or `linux` adds no gate.
- `exec: { kind: "host", command, artifact?, provision? }` — the program runs directly on the node (no container), so
  a Windows service does not need a Docker-capable Windows node.
- `replicas` — a portable instance count.
- `wiring: [{ service, hostEnv?, portEnv?, urlEnv? }]` — inject a peer's coordinates under the env names a
  third-party image expects; every runtime fills them natively. `EVERDICT_SVC_<PEER>` is injected for `needs` peers.
- `resources.gpu` — a GPU count, a portable resource ask like cpu and memory.

Cluster specifics — node class, pool, GPU node selector — are NOT here; they are the runtime-side binding below.

## The capability gate

1. **Vocabulary** — `CAPABILITY_DEFS` (`packages/contracts/src/infra/capability.ts`) has the functional capabilities
   `os-windows`, `os-macos` and `gpu`. Linux is the implicit default and derives nothing.
2. **What a harness requires** — `requiredCapabilitiesForHarness` (`packages/domain/src/runtime/capability-requirements.ts`):
   `docker` only when at least one service is containerized (`topologyNeedsDocker`), `os-<x>` for each non-Linux
   `requires.os` (`requiredCapabilitiesForTopology`), and `gpu` when a service asks for one.
   `requiredCapabilitiesForJob` adds `sandbox` when the case asks for isolation.
3. **What a runtime provides** — for a registered nomad/k8s runtime `defaultRuntimeCapabilities` derives `docker`,
   `sandbox` (hardened runtime), `topology` (a trace source) and `gpu` (a GPU binding); `os-windows`/`os-macos`
   cannot be inferred from the spec and are declared by the operator in `RuntimeSpec.capabilities`
   (`runtimeSpecWithCapabilities` unions both). A self-hosted runner probes its own platform and advertises
   `os-windows`/`os-macos` (`packages/self-hosted-runner/src/capabilities.ts`).
4. **Enforcement** — `RuntimeDispatcher` refuses a job whose requirements `runtimeSatisfies` rejects before dispatch
   (a runtime that declared no capabilities is not gated); the self-hosted pool refuses a job no runner in it can
   run. The web grey-badges an unmet runtime through the same `functionalGate`
   (`apps/web/src/entities/runtime/model/capability-fit.ts`).

The gate answers "can this runtime run this topology at all". Putting a given service on a matching node is the
adapter's job.

## Runtime realizations — below the seam

- **K8s** (`k8s-topology.ts`) — already one Deployment + Service per service, wired by Service DNS, and `replicas`
  is honored natively. `requires.os` becomes `nodeSelector: { "kubernetes.io/os": <os> }` (`macos` → `darwin`). A
  host-exec service is refused fail-fast — K8s has no non-container path.
- **Nomad** (`nomad-topology.ts`) — `needsPerServiceGroups(spec)` is true when any service has a non-Linux OS,
  `replicas > 1`, or is host-exec. Otherwise the topology deploys as ONE co-located group
  ([nomad-colocated-topology.md](./nomad-colocated-topology.md)). Per-service groups are the K8s model on Nomad's
  own primitives, with no extra infrastructure:
  - one group per service (`everdict-svc-<name>`), `Count = replicas`, constraint `${attr.kernel.name}` from
    `requires.os`;
  - each ported service registered in Nomad-native service discovery (`Provider: "nomad"`);
  - peers resolved by a `local/peers.env` template over the native catalog (`nomadService`), with
    `ChangeMode: restart` so a peer reschedule re-resolves — the Service-DNS analog;
  - Windows/macOS groups omit the Linux bridge network mode; a host-exec service runs as a `raw_exec` task that
    binds its declared port as a reserved port, after an optional `provision` prestart task.

  Consul is not used for discovery. When a `ConsulClient` is injected, `NomadTopologyRuntime` applies tenant
  intentions (`consul-intentions.ts`) — an authorization decision, not the data plane.
- **Docker (self-hosted, one host)** — provides only the host OS; a runner advertises only its own platform, so a
  mixed-OS topology fails the gate. A host-exec service is refused fail-fast.

Co-location is an optimization, not a guarantee: the only portable guarantee is name-reachability. Per-service groups
also remove the co-location bottleneck — each service is bin-packed as its own group, `replicas` lifts the
single-instance cap, and a reschedule affects one service rather than the whole topology. The session services
behind a declared pool can be scaled between replica bounds by the pool autoscaler
([target-acquisition-generalization.md](./target-acquisition-generalization.md), `acquire.capacity.scale`).

A spec with no `requires`, all-container services and `replicas: 1` derives no new capability and renders the same
co-located Nomad job, K8s manifests and Docker commands as before.

## Runtime-side placement binding (GPU / node pool)

`RuntimeSpec` (`packages/contracts/src/infra/runtime-spec.ts`) carries the operator-owned binding, never the harness:

- nomad and k8s: `gpu?: number` — reserve N GPUs per job (`device "nvidia/gpu"` in `buildNomadJob`,
  `nvidia.com/gpu` requests = limits in `buildK8sJob`);
- k8s: `nodeSelector?` and `tolerations?` on the pod spec;
- nomad: `constraints?: {attribute, operator?, value}[]` on the task group.

They flow `RuntimeSpec → nomadRuntimeOptions / k8sRuntimeOptions` (`packages/backends/src/placement/build-runtime-backend.ts`)
into the job builders. The GPU count composes: the case's `resources.gpu`, else the harness's, else the runtime
binding's default. So the COUNT is portable while WHICH node pool it lands on stays runtime-owned.
