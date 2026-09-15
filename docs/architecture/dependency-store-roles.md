---
kind: wiki
title: "Dependency store roles — plumbing vs data, and data-as-condition"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/harness/harness-spec.ts, packages/contracts/src/execution/eval-case.ts, packages/topology/src/deploy/store-seed.ts, packages/graders/src/store-state.ts, apps/web/src/features/register-harness/lib/build-spec.ts]
---
# Dependency store roles — plumbing vs data, and data-as-condition

> A service-topology harness's dependency stores are split by ROLE: a store's *plumbing* stays with the harness,
> while a store's *data* is a first-class experiment condition owned by the dataset. A spec that sets none of the
> fields below dispatches exactly as a spec without them. Parent: [service-harness.md](../service-harness.md).
> Siblings: [judge-placement-locality.md](./judge-placement-locality.md) (store-locality grading),
> [streaming-case-pipeline.md](./streaming-case-pipeline.md) (recording seal),
> [portable-harness-runtime.md](./portable-harness-runtime.md),
> [front-door-generalization.md](./front-door-generalization.md) (the `isolateBy`→wiring precedent).
>
> - **P1 — role split (`purpose`) and the `management` wizard axis.** Shipped.
> - **P2 — data as condition** (`EvalCase.fixtures` → seed → `StoreStateGrader`). Shipped on Docker (self-hosted),
>   K8s and Nomad, for silo and pool placement, across postgres, redis and minio. Live-verified against a real
>   postgres and minio by `scripts/live/store-fixture-seed.mjs`.
> - **P3 — `StoreSpec`.** Not built, deliberately (see below).

## The split

A `kind:"service"` topology harness declares `dependencies[]` — shared state stores (`postgres` / `redis` /
`minio`) the runtime brings up alongside the services (`TopologyDependencySchema` in
`packages/contracts/src/harness/harness-spec.ts`: `{store, role, purpose, isolateBy, service?, inject?, storeConfig?}`).
One list used to hold two different things:

1. **Plumbing** — the agent's own execution state (LangGraph checkpoints in redis, a session DB). It comes up
   **empty**; `isolateBy` gives each case a logical namespace (`schema=run_<id>` etc., `isolationVar` in
   `packages/topology/src/environment-manager.ts`) so concurrent cases don't collide. Its content is not an
   experiment variable — it is how the agent runs, so it is **harness-owned**.
2. **World-state** — data the task operates ON (a DB pre-loaded with fixtures the agent must transform; the store
   whose final state IS the verdict). Its content is the experiment INPUT, so it is **dataset-shaped**.

The store is not pulled out of the harness — a redis-for-checkpoints is meaningless without the agent that
checkpoints to it. Each side maps onto the entity that already owns that concern:

| Everdict entity | owns | store aspect that lands here |
| --- | --- | --- |
| **harness** | the agent (+ its plumbing) | store **existence / connection / isolation** (a container in the topology) |
| **dataset / case** | world-state + task + expected = the experiment **variable** | store **content** (the seed fixture) |
| **runtime** | placement (pool/silo/external, `packages/topology/src/deploy/store-binding.ts`) | *(never knows the store kind)* |

Decision rule: **experiment variable → dataset; agent plumbing → harness; placement → runtime.**

## Mechanics shared by every store

- **Connection = env injection at container launch.** The service image reads `DATABASE_URL` / `REDIS_URL` / … from
  its env; Everdict never modifies the app. Each service's env is merged in a fixed precedence across the three
  runtimes (`docker-runtime.ts` / `k8s-topology.ts` / `nomad-topology.ts` under `packages/topology/src/deploy/`):
  `connEnv (convention) < service.env < storeEnv (operational) < dependencyInjectEnv (BYO names)`.
  `dependencyConnEnv` / `dependencyInjectEnv` are the one pure renderer shared by all three builders.
- **Store address** resolves per runtime: docker alias DNS, K8s Service DNS, Nomad loopback (co-located) or a
  discovered `host:port` via `storeEnv`.
- **Who deploys the store?** `StoreIsolation` = `pool | silo | external` (`resolveStoreIsolation`): `external`
  deploys nothing (BYO endpoint); `silo` deploys a dedicated store per tenant; `pool` deploys one cluster-shared
  store deploy-if-absent (`ensureSharedStores`, K8s/Nomad) and mints per-tenant logical isolation (dedicated
  DB/role, Redis ACL, MinIO bucket). Docker (self-hosted) always deploys per topology, adopting an already-running
  same-name set across runner processes.
- **Per-case isolation** is logical namespacing keyed by `isolateBy`, surfaced to the agent as per-run wiring
  (`wiringVars` → `{{thread_id}}` / `{{schema}}` / … in the front-door body). The store PROCESS is warm; the
  per-case slice is the isolation unit.
- **Tuning follows purpose.** `storeConfig` (`memoryMb` / `evictWhenFull` / `persistence`) overrides a
  purpose-derived default: plumbing is an eval cache (bounded, LRU, no persistence), data is durable (unbounded,
  no eviction, persisted) so seeded world-state is never evicted. When several dependencies share one deployed
  store, the durable settings win.

## P1 — role split (`purpose`)

`purpose: z.enum(["plumbing", "data"]).default("plumbing")` on `TopologyDependencySchema`. `role` stays a free-form
human label (`main`, `cache`); `purpose` carries the machine-meaningful category, and a fixture binds to a store by
`(store, role?)`. An existing spec parses as `plumbing` and deploys identically.

### `isolateBy` is three axes, so the wizard shows one

The contract's `isolateBy` enum (`thread_id | key-prefix | object-prefix | schema | external`) mixes three orthogonal
concepts:

1. **Physical partition mechanism** (`schema` / `key-prefix` / `object-prefix`) — 1:1 with the store kind
   (postgres→schema, redis→key-prefix, minio→object-prefix), so it is derivable, never a real choice.
2. **Who isolates** (`thread_id`) — the agent manages per-case isolation through its own thread/session id.
3. **Deploy model** (`external`) — whether Everdict deploys the store at all.

The contract enum stays (it is the wiring vocabulary `wiringVars` / `isolationVar` consume). The wizard
(`apps/web/src/features/register-harness/ui/register-harness-wizard.tsx`) instead asks `purpose` first, then ONE
`management` axis, and derives `isolateBy` from `(management, store)` via `isolateByForManagement` /
`managementFromIsolateBy` (`apps/web/src/features/register-harness/lib/build-spec.ts`):

| `management` (author picks) | derived `isolateBy` |
| --- | --- |
| **Everdict-managed** (default) | from the store kind (postgres→`schema`, redis→`key-prefix`, minio→`object-prefix`) |
| **Agent-isolated** | `thread_id` |
| **External (BYO)** | `external` |

Selecting External shows which conventional key to set (`CONVENTIONAL_CONN_KEY`: postgres→`DATABASE_URL`,
redis→`REDIS_URL`, minio→`AWS_S3_ENDPOINT`) and an endpoint field with an optional workspace-secret reference, which
`build-spec.ts` emits into the service env. A `data` store states that it is seeded per case from the dataset's
fixtures.

## P2 — data as experiment condition

### Where fixtures live
The store INSTANCE stays a topology container; only the CONTENT is dataset-owned. Fixtures are **case data**,
additive and orthogonal to `env` (a topology case's `env` is its target, and a browser task can also seed a DB):

```ts
// packages/contracts/src/execution/eval-case.ts
export const StoreFixtureSchema = z.object({
  store: z.enum(["postgres", "redis", "minio"]),
  role: z.string().optional(),       // bind to one dependency when several share a store kind
  seed: z.union([z.object({ inline: z.string() }), z.object({ ref: z.string() })]),
  format: z.enum(["sql", "redis-cmds", "objects"]).optional(), // default inferred from the store kind
});
// EvalCaseSchema: fixtures: z.array(StoreFixtureSchema).optional()
```

### Seeding
`ServiceTopologyBackend` (`packages/topology/src/service-backend.ts`) seeds after the warm topology is up and before
the front-door drive:

1. `planStoreSeed` (`packages/topology/src/deploy/store-seed.ts`, pure) binds and validates each fixture against a
   `purpose:"data"` dependency and resolves the case's isolation slice; a bad target throws.
2. Artifact-`ref` seeds are resolved to inline bytes through the injected `resolveSeedRef`, so a runtime only ever sees
   inline seeds.
3. `TopologyRuntime.seedFixtures` (Docker, K8s and Nomad runtimes) applies each plan into the slice: postgres creates
   the per-case schema and applies the SQL inside it; redis and minio scope keys/objects with the `{prefix}` placeholder
   (minio seeds with root credentials, so pool placement needs no per-tenant keys).
4. A case with fixtures on a runtime without `seedFixtures` fails the run — the required world-state cannot be
   established.

### Store-state grading
`StoreStateGrader` (`packages/graders/src/store-state.ts`) grades the POST-RUN state of a data store: it reads the
case's slice through `GradeContext.readStore` (backed by `TopologyRuntime.readStoreState`, a co-located runtime exec)
and compares the output to `expect` (falling back to `case.expected`), `contains` or `exact`. Co-location is the
point: an internal store URL never reaches a remote grader. A context without `readStore` is a loud configuration
error, not a pass. The postgres read scopes via the connection's `search_path` startup option rather than a `SET`
statement, which would echo into the read output.

### Reproducibility
The recording's `DispatchManifest` (`packages/contracts/src/execution/recording.ts`) carries `fixtures` — the
content hash of the case's fixtures — so a run's initial world-state is sealed for audit
([replay.md](./replay.md)). A fixture is immutable data like the rest of the dataset.

## P3 — `StoreSpec` (not built)

The remaining code coupling is the closed `store: z.enum(["postgres","redis","minio"])` plus the hardcoded
`STORE_DEFS`. Supporting a non-default store (postgres 15, mysql, qdrant) would promote it to an inline declarative
store definition (image, port, boot env, connection-env template, isolation capabilities), keeping the three
built-ins as defaults — the same evolution `CommandHarness` / `RuntimeSpec` made. Stores would **not** become a
versioned registry entity: most stores are plumbing, so that adds indirection without decoupling. Deferred until a
real non-default-store request lands.

## Open questions

- **`thread_id` presentation.** Should the wizard infer agent-managed isolation from the front-door protocol
  (LangGraph-shaped) rather than offer it as an explicit `management` choice?
- **Two-level warm key.** When a whole dataset shares one fixture, seeding once per
  `(harness, dataset-fixture-hash)` and namespacing per case on top would save re-seeding; nothing does this today.
