# Heterogeneous topology placement — infra-agnostic (capability-driven)

**Status: design draft.** Scope: let a `kind:"service"` topology contain services that require **different
execution environments** (e.g. a Windows Playwright browser-farm service alongside Linux agent services) and stop
the single co-located host from being a placement/throughput bottleneck — **without leaking any orchestrator
detail into the harness**. This supersedes the earlier Nomad/Consul-specific draft: infra specifics belong
*below* the `TopologyRuntime` interface, never in the contract.

## The principle

Everdict is **infra-agnostic**: a registered harness (`(tenant, id, version) → HarnessSpec`) must run on **any**
runtime — a laptop's Docker, any Nomad, any K8s. So the fix is stated at the abstraction the codebase already
owns, not at Nomad's:

> **The harness declares WHAT each service needs (a capability) and addresses peers by name (`<svc.name>:<port>`).
> WHERE/HOW they are placed, co-located, discovered across hosts, and scaled is entirely the `TopologyRuntime`
> adapter's business. Consul / Nomad constraints / K8s `nodeSelector` live *inside* an adapter — the same idiom as
> every other pluggable adapter here (`Backend`/`Driver`/`Harness`).**

This is **not new machinery** — it is the existing capability model
(`packages/contracts/src/infra/capability.ts`), whose SSOT comment already promises: *"a runtime self-probes and
advertises, a harness derives its requirements → matching is enforced by the per-kind layer. **Adding a capability
= add one line here.**"* OS heterogeneity is exactly that: one more `functional` capability.

## What is already portable (unchanged)

- **Peer addressing.** Every runtime resolves `<svc.name>:<port>` its own way — Docker network-alias, K8s Service
  DNS, Nomad loopback/Consul. The harness never assumes co-location; it assumes *name-reachability*. This holds
  regardless of which node/OS a peer lands on.
- **`TopologyRuntime` interface.** `ensureTopology(spec, zone) → { endpoints }` (keyed by service name) is
  unchanged. Placement + cross-host discovery are the adapter's internals behind this seam.
- **`TopologyService.replicas`** already exists (`harness-spec.ts`). It is a *portable* declaration; each runtime
  honors it natively. (Nomad ignores it today only because a shared netns can't bind a port twice — an adapter
  limitation, not a contract one.)

## Contract — one abstract, portable field

`TopologyService` gains an **intrinsic requirement**, never a node selector:

```ts
// harness-spec.ts — TopologyService
requires: z.object({
  os: z.enum(["linux", "windows", "macos"]).optional(), // the service's IMAGE genuinely needs this OS (portable capability, not a cluster label)
}).optional(),
```

`requires.os` is a **capability**, not placement: a Windows Playwright image needs Windows on *any* infra. Cluster
specifics (node class, datacenter, pool, GPU) are **NOT** here — those are runtime-owned (a runtime-side binding
set by whoever operates the cluster), out of the harness. Unset / `linux` adds **no gate** (today's behavior).

## Capability wiring (existing gate, one new vocabulary line)

1. **Vocabulary** (`capability.ts`, `CAPABILITY_DEFS`): add `"os-windows": { kind: "functional" }` and
   `"os-macos": { kind: "functional" }`. `linux` stays the implicit default (no capability, no gate → zero churn
   for the common case).
2. **Harness requirement** (`requiredCapabilities`, extended for topology): a topology requires
   `os-<x>` for each distinct non-Linux `service.requires.os`, unioned with its base (`docker`/`topology`). So a
   Windows+Linux topology requires `{docker, topology, os-windows}`.
3. **Runtime advertisement** (`defaultRuntimeCapabilities` + the runner's self-probe): a runtime advertises
   `os-windows`/`os-macos` **only when its node pool actually has such nodes** (self-probed, like the runner's
   `detectCapabilities`). A laptop Docker advertises only its host OS.
4. **Placement gate** (`functionalGate`/`runtimeSatisfies`, unchanged): a mixed cluster provides
   `{os-linux(implicit), os-windows}` ⊇ the topology's `{os-windows}` → candidate. A Linux-only runtime lacks
   `os-windows` → **excluded, shown grey** in the web runtime badge (the existing capability UX) — a clean
   "unsupported here", never a broken run.

The coarse gate answers *"can this runtime run this topology at all?"*. The fine-grained *"put THIS service on a
windows-capable node"* is the adapter's private job (below).

## Runtime realizations — implementation detail, below the seam

None of this appears in the harness or contract. Each `TopologyRuntime` satisfies the same declared capability its
own way:

- **K8s** — already one Deployment+Service per service wired by Service DNS. `requires.os` →
  `nodeSelector: { "kubernetes.io/os": "windows" }` + the standard Windows toleration. **No data-plane change**;
  the mixed-OS gap on K8s is purely the missing field this contract adds. Lowest-risk realization.
- **Nomad — the K8s model, natively (preferred).** Make Nomad **isomorphic to K8s**: **one Consul-registered
  group per service** (the Deployment+Service analog). Peers resolve `<svc.name>` via **Consul service DNS**
  (re-resolving + health-gated — the Service-DNS analog, replacing loopback `extra_hosts`); placement via
  `constraint ${attr.kernel.name}` from `requires.os` (the `nodeSelector` analog); scale via group `Count =
  replicas`. Per-service groups = per-service netns, so the co-location unique-port constraint disappears. This is
  the **old per-service-group shape done right**: the addresses that used to go stale (dynamic host ports baked in)
  are now re-resolved through Consul. **It reproduces the operator's already-working Windows-Playwright + Linux +
  Consul harness** — that proven wiring is the Nomad adapter's reference implementation, entirely inside the
  adapter.
  - **Fallback (no Consul).** Everdict cannot hard-require Consul, so a Nomad runtime **without** a service-discovery
    substrate falls back to the current single co-located group (loopback) — degraded to **single-OS, single
    instance** (today's behavior, no regression). Gate it: heterogeneous / replicated topologies need a
    `service-discovery`-capable Nomad runtime; without it they're excluded (grey), exactly like any unmet
    capability. Co-location code is retained as this fallback path, not deleted.
- **Docker (self-hosted, single host)** — provides only the host OS, so a mixed-OS topology simply doesn't match
  the gate and is declined cleanly (a second-OS daemon is a later runner capability, not a contract change).

## Co-location & scale-out are runtime optimizations, not contract guarantees

The only portable guarantee is name-reachability. Whether an adapter co-locates services (loopback latency,
atomic lifecycle) or spreads them per-service (the K8s model), and how it scales, is its own call. Under the
K8s-style Nomad realization (one Consul-registered group per service) the **co-location bottleneck** dissolves
with no harness change:

- **Bin-packing** — each service is packed as its own group, never summed into one fat node.
- **Throughput ceiling** — the existing `replicas` maps to the service group's `Count`; callers load-balance over
  the discovered instances (Consul returns N, health-gated), lifting the old `Count 1` single-instance cap.
- **Blast radius** — per-service reschedule instead of the whole-topology alloc.

(The co-location fallback keeps today's single-instance behavior when no service-discovery substrate is available.)

Warm-pool-of-N instances (whole-topology horizontal scale) remains a separate, adapter-level follow-up; per-run
isolation is logical (`thread_id`/key-prefix/object-prefix), so N stateless instances are equivalent.

## No-regression

A spec with no `requires` (or all-`linux`) and `replicas:1` derives no new capability, gates identically, and
renders byte-identical Nomad/K8s/Docker output → existing `topology.test.ts`/`k8s.test.ts`/`nomad-runtime.test.ts`
golden assertions unchanged. New paths engage only when a service declares a non-Linux OS or `replicas>1`.

## Slices

- **P1 — capability + gate (infra-agnostic core, mixed-OS placement).** `TopologyService.requires.os` +
  `os-windows`/`os-macos` in `CAPABILITY_DEFS` + `requiredCapabilities`(topology)/`defaultRuntimeCapabilities`
  wiring + web grey-badge on unmet. Realizations: **K8s `nodeSelector`** (lowest risk, land first — it *is* the
  model) → **Nomad K8s-style** (per-service Consul-registered group + `${attr.kernel.name}` + Consul service DNS,
  reproducing the operator's working harness; co-location kept as the no-Consul fallback) → **Docker decline**.
  Homogeneous topologies untouched.
- **P2 — honor `replicas` per service (throughput/bottleneck).** Nomad service group `Count` + Consul LB over
  discovered instances; K8s already honors replicas.
- **P3 — warm-pool-of-N + case load-balancing (whole-topology scale).** Adapter-level.

## Files

- `packages/contracts/src/infra/capability.ts` — `os-windows`/`os-macos` vocabulary entries.
- `packages/contracts/src/harness/harness-spec.ts` — `TopologyService.requires.os`.
- `packages/domain/src/runtime/capability-requirements.ts` — topology OS → required capabilities; runtime OS
  advertisement (self-probe hook).
- `packages/topology/src/deploy/{k8s-topology,nomad-topology,nomad-runtime,docker-runtime}.ts` — native
  realizations (nodeSelector / per-service Consul group + constraint + Consul service DNS / single-host decline).
  **All infra specifics confined here, behind `TopologyRuntime`.**
- Supersedes the "one group, whole topology" invariant in `nomad-colocated-topology.md`: the default Nomad model
  becomes the **K8s-style per-service Consul** one, and co-location is demoted to the no-Consul fallback — update
  that doc + the `topology`/`self-hosted-runner` skill references when code lands.
```
