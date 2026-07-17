# Runtime inspection — a live cluster read model

A registered runtime (`RuntimeSpec`) is a **static registration** — "where/how to dispatch". The runtime
detail screen historically showed only that spec. **Runtime inspection** adds a read-only *live* view of the
cluster behind a nomad/k8s runtime, answering four operator questions the spec cannot:

| Question | Facet | Source |
|---|---|---|
| How is this cluster composed / is it healthy? | `nodes` (+ `cluster.datacenters`) | Nomad `/v1/nodes` · K8s `get nodes` |
| What machine is each node (OS/arch/kernel/runtime/agent/IP/disk)? | `nodes[].{os,arch,kernel,containerRuntime,agentVersion,address,diskMbTotal,diskMbUsed}` | Nomad `/v1/node/:id` Attributes · K8s node `status.nodeInfo`+`addresses`+`allocatable`, kubelet stats summary |
| Does it have room to run jobs right now? | `capacity` (total/used/free) | the same live count `Backend.capacity()` gates on |
| What is running here (everdict AND external) / should anything be reclaimed? | `workload` (running/pending units + age + `role`/`namespace`/`ownerKind`) | Nomad `/v1/allocations` (all) · K8s `get pods -A` |
| Are there shared stores, and at what address? | `stores` | Nomad `everdict-shared-*` allocs · K8s `get svc -n everdict-shared` |

## Shape & layering

- **Capability, not a Backend method.** `Inspectable` (`inspect(): Promise<InspectRuntimeResult>`) is a typed
  capability interface with an `isInspectable` guard, exactly like `Probeable` — `NomadBackend`/`K8sBackend`
  implement it; `LocalBackend` (no cluster) does not. See skill `backends`.
- **One schema SSOT.** `InspectRuntimeResult` lives in `@everdict/contracts/wire`; the `Inspectable` interface
  reuses it **type-only** (no drift, no runtime edge), the apps/api OpenAPI + MCP reuse the schema, and the web
  anchors a local zod boundary schema to it with a bidirectional drift guard.
- **Transport parity.** apps/api wraps the backend behind `makeRuntimeInspector` (mirrors `makeRuntimeProber`:
  build a live backend with the tenant's secrets → `inspect()` with a timeout). Surfaced as
  `GET /runtimes/:id/versions/:version/inspect` **and** the `inspect_runtime` MCP tool, both gated `runtimes:read`
  (it is a read — unlike probe's `runtimes:write`), both resolving the registered spec by id before any live I/O
  (a non-owned/missing runtime is 404, no existence leak). The web calls it via the `inspectRuntimeAction`
  token-courier BFF and renders the "Cluster status" panel. The panel **loads on entering the detail screen and
  re-polls on a cadence** (`CLUSTER_REFRESH_MS`, 20s) so the view stays live without a manual click; the poll pauses
  while the tab is hidden or the operator is mid-action (a confirm modal is open / a control action or a prior fetch
  is in flight — a `busyRef` guard), and a refresh keeps the current view on screen instead of blanking it. A manual
  "Refresh" button remains for an on-demand re-read.

## Degrade contract (important)

Inspection is **TOTAL / best-effort**, like probe:

- Reachability (the first call: Nomad `/v1/agent/self`, K8s API-server version) is the **whole-cluster verdict** —
  a failure returns `{reachable:false, reason}` and no sections.
- Once reachable, **each sub-read is independent**: a failure records a note in `warnings[]` and omits that
  section — it never throws and never fails the whole view. A degraded cluster still renders honestly.
- A build/config error (bad spec, missing secret) is distinct — the service returns `reason:"error"`.
- The workload list is capped (`WORKLOAD_CAP`); an overflow is disclosed in `warnings` (no silent truncation).

## The whole cluster, not just everdict (workload occupancy)

The workload list is **every** running/pending unit on the cluster, not only the units everdict placed — because the
detail screen answers "what actually occupies this node right now", and a node's real tenants include other platforms'
services. Each `InspectWorkload` carries a `role`:

- `eval` — an everdict eval job (Nomad `everdict-*` alloc / K8s pod labelled `app=everdict`).
- `store` — a pool-tier shared store (`everdict-shared-*`).
- `other` — an **external** unit: any non-everdict alloc/pod co-resident on the nodes.

External units also carry `namespace` (the orchestrator namespace) and `ownerKind` (K8s controller kind —
Deployment/StatefulSet/DaemonSet/Job/Pod, resolving a pod's ReplicaSet up to its Deployment; Nomad job type —
service/batch/system). The `name` of an external K8s unit is the **pod** name (what namespace-scoped control targets);
an everdict unit keeps its job/job-name. Under `WORKLOAD_CAP` (100), everdict units are kept ahead of external ones so
a busy external cluster can't crowd out the eval view; the overflow is disclosed in `warnings`.

Because the one pod/alloc listing now covers every unit, the per-node **committed load** (`cpuUsed`/`memoryMbUsed`) is
summed from those same rows (K8s: `usageByNode` over the inspected rows, no second `get pods -A`; Nomad still reads each
node's `/v1/node/:id/allocations` for the true all-jobs figure).

## Node identity (what machine is this?)

Beyond CPU/memory totals, `InspectNode` carries best-effort host identity so the node card reads like a real machine:
`os` / `arch` / `kernel` / `containerRuntime` / `agentVersion` (Nomad client / kubelet) / `address` (internal IP) /
`diskMbTotal` + `diskMbUsed` (local storage). Sources: **Nomad** the fingerprinted node `Attributes`
(`os.name`+`os.version`, `cpu.arch`, `kernel.*`, `driver.docker.version`, `nomad.version`, `unique.network.ip-address`,
`unique.storage.bytes{total,free}`); **K8s** node `status.nodeInfo` (`osImage`/`architecture`/`kernelVersion`/
`containerRuntimeVersion`/`kubeletVersion`) + `addresses` InternalIP + `allocatable.ephemeral-storage` as the disk-total
fallback, **refined** by the kubelet stats summary (`/nodes/:node/proxy/stats/summary` → real fs capacity/used) where the
API server permits the proxy subresource (managed clusters / tight RBAC simply omit it — every field is independently
best-effort). Per-node detail reads are capped (`NODE_DETAIL_CAP`, 30) to bound the calls on a big cluster.

## The shared-store nuance

Shared stores are **not** a persistent property of a runtime — they belong to *topology harnesses*
(`packages/topology`, pool tier), which stand `everdict-shared-<store>` up on the cluster and tear it down.
Inspection therefore surfaces what is *actually standing on the cluster now*, discovered by the stable
`everdict-shared-` naming convention (kept in sync with `sharedStoreName()`):

- **K8s**: one `Service` per store → the address is its deterministic Service DNS
  (`everdict-shared-<store>.<ns>.svc.cluster.local:<port>`).
- **Nomad**: the port is a dynamic alloc port, so the store's presence/status is shown and the address is left
  unknown (honest omission over a wrong guess). A harness's own external/BYO store address lives in its
  `HarnessSpec` (`storeEnv`), viewed on the harness detail — not here.

## Control actions (Reclaimable)

Inspection is paired with **destructive control** — the `Reclaimable` capability
(`stopWorkload` / `reclaimIdle` / `purgeTerminal` / `setNodeSchedulable` / `resizeWorkload`), wrapped by apps/api
(`makeRuntimeController`, mirroring the prober) behind `POST /runtimes/:id/versions/:version/control`
+ the `control_runtime` MCP tool, and surfaced as confirm-gated buttons on the panel.

- **Gate.** A NEW admin-only action `runtimes:control` (packages/domain authz), distinct from `runtimes:write`
  (viewer+ registration) and admin-scope-only for API keys. Aborting an in-flight eval or taking a node out of
  scheduling is operator governance, not authoring. Unlike inspect (soft), a build/kind failure THROWS an AppError
  (mutating action → real 4xx/5xx); a `local` runtime is 400.
- **The actions.** `stopWorkload(name, namespace?)` force-stops one live unit — an everdict unit (deregister/delete
  its job — a BLUNT infra reclaim, *distinct from the graceful run/scorecard cancel*), or with the unit's
  `namespace` an **external** service (K8s: resolve the pod's ROOT controller and delete IT — deleting a
  Deployment's pod just respawns; Nomad: deregister the namespaced job). `reclaimIdle` bulk-stops non-store
  **everdict** units older than a threshold (external units are never swept); `purgeTerminal` GCs dead/completed
  jobs (no live impact); `setNodeSchedulable(node, schedulable)` cordons/uncordons a node (reversible, no eviction —
  Nomad eligibility / `kubectl cordon`); `resizeWorkload(name, {cpu?,memoryMb?}, namespace?)` changes a unit's
  resource ask in the runtime's NATIVE units (Nomad CPU MHz / K8s millicores; memory MiB) by **replacing** the unit
  (Nomad: rewrite a single-task job's Resources and resubmit — the alloc is replaced; K8s: patch the pod's owning
  controller template — a rolling update). These four are best-effort/idempotent; **shared stores are never
  reclaimed**, and **cluster-infra namespaces** (kube-system/kube-public/kube-node-lease) are refused for
  stop/resize. `resizeWorkload` is the one **deliberately loud** action — an unsupported target (multi-task /
  multi-container unit, a K8s Job whose pod template is immutable, a bare pod with no controller, or an empty
  resize) THROWS a 4xx rather than silently no-op, so "done" always means the resize took. The UI re-inspects after.
- **State-aware cordon.** `InspectNode.schedulable` (Nomad eligibility / k8s `!unschedulable`) lets the panel show
  the right toggle. The web gates the buttons on the `can.ts` mirror (`runtimes:control`) — enforcement is still the
  control plane's (403). Resize (needs input) opens a small dialog with cpu/memory number fields prefilled from the
  unit's current ask; stop of an external unit reads as "terminate this service" with a namespace-aware confirm.

## Node-centric topology view

The panel renders a **Lens-style node topology**: one card per node with a CPU + memory usage bar and the
workloads placed on it (with inline stop + a per-node cordon toggle). The data:

- `InspectNode` carries `cpuTotal` / `memoryMbTotal` (total schedulable, in the runtime's NATIVE unit — Nomad CPU
  MHz, K8s CPU millicores; memory MiB) and `schedulable`. Nomad reads `/v1/node/:id` `NodeResources` (per node,
  capped at 30 to bound the calls); K8s parses node `status.allocatable` (`k8sCpuToMillicores` / `k8sMemToMiB`).
- `InspectNode` **also carries `cpuUsed` / `memoryMbUsed` — the node's REAL committed load across EVERY workload on
  it, not just everdict.** A shared cluster runs other platforms' jobs; a gauge fed only by the everdict units the
  view can see understates a busy node. So the backend reads the node's true commitment: **Nomad** sums the
  `AllocatedResources` of every running/pending alloc on the node (`/v1/node/:id/allocations` → `nomadNodeAllocated`);
  **K8s** sums the container `requests` of the inspected all-namespace pod rows grouped by node (`usageByNode` over the
  one `get pods -A` listing that also feeds the workload view). Same native units as the totals. Best-effort — an
  unavailable read simply omits the field.
- `InspectWorkload` carries `cpu` / `memoryMb` (its resource ask, same units) + its `node`. Nomad sums the alloc's
  `AllocatedResources.Tasks`; K8s sums the pod's container `requests` — these size the workload chips (everdict and
  external alike).
- The web's per-node usage bar uses `cpuUsed` / `memoryMbUsed` when present (true node load), and only falls back to
  the sum of the visible units' asks when the cluster didn't report the node's committed load. A **third disk gauge**
  (`diskMbUsed` / `diskMbTotal`) renders when both are known (else a plain "Disk: <total>" line when only the capacity
  is). Units are native-per-kind (the web labels MHz vs cores from `insp.kind`); memory/disk MiB→GiB→TiB. A compact
  identity strip under the node name shows OS/arch, container-runtime + node-agent versions, and IP (only the reported
  fields). All best-effort: a node that omits resources simply has no bar/strip. Node-less units fall into an
  "unscheduled" group; if node listing degrades, the panel falls back to the flat workload list. External units render
  identically with an "external" badge (+ namespace/owner in the hover) and expose stop (terminate) and, where
  supported, resize.

## Deliberate non-goals (v1)

- **No auto-scaling of the everdict eval pool from the panel** — the Autoscaler already drives that capacity from
  queue depth; a manual knob for it would fight it. Cordon (take a node out of rotation) is the node-level lever, and
  `resizeWorkload` targets an *individual* external service or Nomad job, not the eval pool's autoscaled envelope.
- **No force-graph layout** — the node-card grid is the Lens/Nomad-topology idiom; a force-directed SVG graph would
  add a heavy layout dependency for little operator value over sized cards + resource bars.
- **No in-place K8s eval-Job resize** — a K8s Job's pod template is immutable, and an eval job's resources are the
  harness spec's job (sized at registration), so resize is refused there (a clear 400). It targets external
  controllers (Deployment/StatefulSet/DaemonSet) and Nomad single-task jobs.
