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
  token-courier BFF and renders the "Cluster status" panel on demand.

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

## Deliberate non-goals (v1)

- **No mutating actions** (kill idle allocs / scale down) — visibility only; reclaim is a possible follow-up.
- **No per-node resource totals** — the cheap list endpoints don't give clean, comparable CPU/memory across
  nomad and k8s; node count + readiness + docker-driver health + the slot `capacity` answer "has it room" without
  a misleading number. Add per-node resources when a live endpoint justifies it.
