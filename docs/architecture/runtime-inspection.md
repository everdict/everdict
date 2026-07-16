# Runtime inspection — a live cluster read model

A registered runtime (`RuntimeSpec`) is a **static registration** — "where/how to dispatch". The runtime
detail screen historically showed only that spec. **Runtime inspection** adds a read-only *live* view of the
cluster behind a nomad/k8s runtime, answering four operator questions the spec cannot:

| Question | Facet | Source |
|---|---|---|
| How is this cluster composed / is it healthy? | `nodes` (+ `cluster.datacenters`) | Nomad `/v1/nodes` · K8s `get nodes` |
| Does it have room to run jobs right now? | `capacity` (total/used/free) | the same live count `Backend.capacity()` gates on |
| What is running here / should anything be reclaimed? | `workload` (running/pending everdict units + age) | Nomad `/v1/allocations` · K8s `get pods -l app=everdict` |
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
(`stopWorkload` / `reclaimIdle` / `purgeTerminal` / `setNodeSchedulable`), wrapped by apps/api
(`makeRuntimeController`, mirroring the prober) behind `POST /runtimes/:id/versions/:version/control`
+ the `control_runtime` MCP tool, and surfaced as confirm-gated buttons on the panel.

- **Gate.** A NEW admin-only action `runtimes:control` (packages/domain authz), distinct from `runtimes:write`
  (viewer+ registration) and admin-scope-only for API keys. Aborting an in-flight eval or taking a node out of
  scheduling is operator governance, not authoring. Unlike inspect (soft), a build/kind failure THROWS an AppError
  (mutating action → real 4xx/5xx); a `local` runtime is 400.
- **The four actions.** `stopWorkload(name)` force-stops one live everdict unit (deregister/delete its job) — a
  BLUNT infra reclaim of a stuck/orphaned unit, *distinct from the graceful run/scorecard cancel*; `reclaimIdle`
  bulk-stops non-store units older than a threshold; `purgeTerminal` GCs dead/completed jobs (no live impact);
  `setNodeSchedulable(node, schedulable)` cordons/uncordons a node (reversible, no eviction — Nomad eligibility /
  `kubectl cordon`). Each is best-effort/idempotent; **shared stores are never reclaimed**; the UI re-inspects after.
- **State-aware cordon.** `InspectNode.schedulable` (Nomad eligibility / k8s `!unschedulable`) lets the panel show
  the right toggle. The web gates the buttons on the `can.ts` mirror (`runtimes:control`) — enforcement is still the
  control plane's (403).

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
  **K8s** sums the container `requests` of every running/pending pod across all namespaces grouped by node
  (`get pods -A` → `podRequestsByNode`). Same native units as the totals. Best-effort — an unavailable read simply
  omits the field.
- `InspectWorkload` carries `cpu` / `memoryMb` (its resource ask, same units) + its `node`. Nomad sums the alloc's
  `AllocatedResources.Tasks`; K8s sums the pod's container `requests` — these size the everdict workload chips.
- The web's per-node usage bar uses `cpuUsed` / `memoryMbUsed` when present (true node load), and only falls back to
  the sum of the visible everdict units' asks when the cluster didn't report the node's committed load. Units are
  native-per-kind (the web labels MHz vs cores from `insp.kind`); memory MiB→GiB. All best-effort: a node that omits
  resources simply has no bar. Node-less units fall into an "unscheduled" group; if node listing degrades, the panel
  falls back to the flat workload list.

## Deliberate non-goals (v1)

- **No auto-scaling from the panel** — the Autoscaler already drives capacity from queue depth; a manual scale knob
  here would fight it. Cordon (take a node out of rotation) is the maintenance lever offered instead.
- **No force-graph layout** — the node-card grid is the Lens/Nomad-topology idiom; a force-directed SVG graph would
  add a heavy layout dependency for little operator value over sized cards + resource bars.
