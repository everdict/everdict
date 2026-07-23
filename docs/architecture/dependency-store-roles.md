# Dependency store roles — plumbing vs data, and data-as-condition (design)

> **Status: design only (not started).** A doc-first SSOT for splitting a service-topology harness's dependency
> stores by ROLE, so a store's *plumbing* stays with the harness while a store's *data* becomes a first-class
> experiment condition owned by the dataset. Every phase is sequenced to keep the live e2e
> (`scripts/live/service-topology-{nomad,k8s}.mjs`) green and to default to today's behavior exactly — a spec that
> sets nothing new dispatches identically to today. Parent: `docs/service-harness.md`. Siblings:
> `judge-placement-locality.md` (store-locality grading), `streaming-case-pipeline.md` (recording seal),
> `portable-harness-runtime.md`, `front-door-generalization.md` (the `isolateBy`→wiring precedent).
>
> - **P1 — role split (`purpose`).** A dependency gains `purpose: "plumbing" | "data"` (default `plumbing` = today).
>   `plumbing` = the agent's own state store (empty at start, per-case logical isolation). `data` = a world-state
>   store whose CONTENT is the experiment variable, seeded per-case from the dataset. `isolateBy` becomes a
>   store-derived default (wizard stops asking it raw). Wizard: purpose-first + an `external` connection sub-form.
> - **P2 — data as condition.** `EvalCase.fixtures[]` (dataset-owned) seeds a `purpose:"data"` store's per-case
>   isolation slice AFTER `ensureTopology`, BEFORE the front-door drive. A co-located store-state grader reads the
>   post-run slice and diffs vs `expected`. The fixture hash is sealed into the recording for reproducibility.
> - **P3 — `StoreSpec` (deferred / YAGNI).** Open the closed `store` enum + `STORE_DEFS` to a declarative store
>   definition, keeping the three built-ins as defaults. Only when a non-default store is an actual need.

## Problem

A `kind:"service"` topology harness declares `dependencies[]` — shared state stores (`postgres`/`redis`/`minio`)
the runtime brings up alongside the services. Today one `TopologyDependency` (`{store, role, isolateBy, service?,
inject?}`, `packages/contracts/src/harness/harness-spec.ts`) conflates two very different things under one list:

1. **Plumbing** — the agent's own execution state (LangGraph checkpoints in redis, a session DB). It comes up
   **empty**; `isolateBy` gives each case a logical namespace (`schema=run_<id>` etc., `environment-manager.ts`
   `isolationVar`) so concurrent cases don't collide. Its content is not an experiment variable — it is just how
   the agent runs. **This is correctly harness-owned** (it is part of the agent's deployable unit).

2. **World-state** — data the task operates ON (a DB pre-loaded with fixtures the agent must transform; the store
   whose final state IS the verdict). Its content is the experiment INPUT, so it is **dataset-shaped**, not
   harness-shaped. **Everdict cannot express this today** — topology stores have no seed path, and there is no
   grader that reads post-run store state.

This conflation has three consequences:

- **The wizard leaks internals.** `register-harness-wizard.tsx`'s dependency section is a field-faithful form over
  the raw contract: it shows `store` / `role` / `isolateBy` (raw spec field names) and makes the user pick
  `isolateBy` — which requires knowing *how their agent isolates* (thread_id for LangGraph vs schema for a DB). That
  is plumbing knowledge pushed onto the author. `external` is a mark-only option (a note, no connection sub-form).
- **Data cannot be a condition.** The stated product goal — "make even the data in these stores an experiment
  condition" — has no home. There is a coordinate-injection pipeline (`dependencyConnEnv`/`dependencyInjectEnv`)
  but no data-seeding pipeline.
- **Grading can't see store state.** The portability lint already warns (`packages/domain/src/harness/portability.ts`)
  that an artifact written to an internal store (`minio:9000`) does not reach the judge. A world-state verdict needs
  a grader co-located with the store.

The fix is not to pull the store out of the harness (plumbing genuinely belongs there — a redis-for-checkpoints is
meaningless without the agent that checkpoints to it). It is to **split by role**, mapping each side onto the entity
that already owns that concern:

| Everdict entity | owns | store aspect that lands here |
| --- | --- | --- |
| **harness** | the agent (+ its plumbing) | store **existence / connection / isolation** (a container in the topology) |
| **dataset / case** | world-state + task + expected = the experiment **variable** | store **content** (the seed fixture) |
| **runtime** | placement (pool/silo/external, `store-binding.ts`) | *(never knows the store kind)* |

Decision rule: **experiment variable → dataset; agent plumbing → harness; placement → runtime.** A store's data is a
variable → dataset. A store's existence-as-checkpoint-DB is plumbing → harness.

## Today's mechanics (for reference)

- **Connection = env injection at container launch.** The service image reads `DATABASE_URL`/`REDIS_URL`/… from its
  env; Everdict never modifies the app. Each service's env is merged in a fixed precedence across all three runtimes
  (`docker-runtime.ts` / `k8s-topology.ts` / `nomad-topology.ts`):
  `connEnv (convention) < service.env < storeEnv (operational) < dependencyInjectEnv (BYO names)`.
- **Store address** resolves per-runtime only: docker alias DNS (build-time), K8s Service DNS (build-time), Nomad
  loopback (co-located) or discovered `host:port` via `storeEnv`. `dependencyConnEnv`/`dependencyInjectEnv` are the
  one pure renderer shared by all three builders.
- **Who deploys the store?** `StoreIsolation` = `pool | silo | external` (`store-binding.ts`
  `resolveStoreIsolation`): `external` deploys nothing (BYO endpoint); `silo` deploys a dedicated store per tenant;
  `pool` deploys one cluster-shared store **deploy-if-absent** (`ensureSharedStores`, k8s/nomad runtimes) then mints
  per-tenant logical isolation (dedicated DB/role, Redis ACL, MinIO bucket). Docker (self-hosted) always deploys per
  topology (no zone), adopting an already-running same-name set across runner processes.
- **Per-case isolation** is logical namespacing keyed by `isolateBy`, surfaced to the agent as per-run wiring
  (`wiringVars` → `{{thread_id}}`/`{{schema}}`/… in the front-door body). The store PROCESS is warm; the per-case
  slice is the isolation unit.

The key gap this design targets: that per-case slice is **created but never seeded**. P2 seeds it.

## P1 — role split (`purpose`)

### Contract delta (`@everdict/contracts`)

`TopologyDependencySchema` gains a `purpose` discriminator; `role` stays a free-form human label.

```ts
// harness-spec.ts
purpose: z.enum(["plumbing", "data"]).default("plumbing"),
//   plumbing (default) = today: empty store, per-case logical isolation, agent's own state.
//   data                = a world-state store; its content is seeded per-case by the dataset (P2) and is gradeable.
```

- **Backward compatible by default.** An existing spec has no `purpose` → parsed as `plumbing` → byte-identical
  deploy/wiring. No runtime branch changes in P1; `purpose` is a semantic marker that P2 consumes and the wizard
  presents.
- `role` is unchanged (still `z.string()`), now clearly "a human label for this store" (`main`, `cache`), while
  `purpose` carries the machine-meaningful category. A P2 fixture binds to a store by `(store, role?)`.

### `isolateBy` is not one axis — it is three (the `management` collapse)

The contract's `isolateBy` enum (`thread_id | key-prefix | object-prefix | schema | external`) conflates **three
orthogonal concepts** into one 5-value choice — which is why a wizard author can't meaningfully pick it:

1. **Physical partition mechanism** (`schema`/`key-prefix`/`object-prefix`) — how Everdict namespaces a shared store
   per case. This is **1:1 with the store kind** (postgres→schema, redis→key-prefix, minio→object-prefix), so it is
   *derivable, never a real choice*.
2. **Who isolates** (`thread_id`) — the agent manages per-case isolation itself via its own thread/session id
   (LangGraph), instead of Everdict physically partitioning. A property of the agent, not the store.
3. **Deploy model** (`external`) — whether Everdict deploys the store at all. Not isolation at all; a different axis
   entirely (it belongs next to `purpose`).

**The contract enum stays** (it is the internal per-case wiring vocabulary `wiringVars`/`isolationVar` consume — the
runtime needs the specific value to know which variable to hand the agent). The change is **wizard-only**: replace the
raw 5-value picker with ONE comprehensible axis, `management`, and **derive** `isolateBy` from `(management, store)`:

| `management` (user picks) | derived `isolateBy` |
| --- | --- |
| **Everdict-managed** (default) | physical, from the store kind (postgres→`schema`, redis→`key-prefix`, minio→`object-prefix`) |
| **Agent-isolated** | `thread_id` |
| **External (BYO)** | `external` |

The physical kinds collapse into "Everdict-managed"; the author never sees `schema`/`key-prefix`/`object-prefix`.
`isolateByForManagement`/`managementFromIsolateBy` (web `build-spec.ts`) do the forward/inverse (prefill) mapping.

### Wizard redesign (`apps/web` `register-harness-wizard.tsx`) — DONE (P1a)

- **Purpose-first.** The first control per dependency is `purpose` (plumbing vs data), replacing raw `isolateBy` as
  the primary question.
- **`management` replaces the raw `isolateBy` enum.** A 3-option combobox (Everdict-managed / Agent-isolated /
  External) with plain-language labels + descriptions. The physical mechanism is derived and never shown; changing
  the store needs no extra work (isolateBy is computed at emit).
- **`external` shows a connection hint.** Selecting External surfaces the note **plus** which conventional key to set
  (`CONVENTIONAL_CONN_KEY`: postgres→`DATABASE_URL`, redis→`REDIS_URL`, minio→`AWS_S3_ENDPOINT`) on which service, so
  the author knows exactly how to point at their store. (A guided endpoint+secret sub-form that *emits* into
  `service.env` is a follow-up — deferred because the emit round-trips ambiguously with a same-key service-env row.)
- **Concept labels over spec field names.** "purpose" / "management" / "used by" instead of `isolateBy`. i18n keys
  added to `messages/{ko,en}.json`.
- **`data` purpose cross-links to the dataset.** A `data` store shows "seeded per-case from the dataset's fixtures"
  (authored dataset-side, P2), so the author understands the seam.

## P2 — data as experiment condition

### Where fixtures live

The store INSTANCE stays a topology container (harness-owned — the runtime must bring it up). Only the CONTENT is
dataset-owned. So fixtures are **case data**, applied to the harness's `purpose:"data"` stores, matched by
`(store, role?)`. They are **additive on the case**, NOT a new `EnvSpec` union kind — a topology case's `env` is
already `kind:"browser"` (the target), and a case has exactly one `env`. Folding stores into that union would make
"browser target" and "store fixtures" mutually exclusive, which is wrong (a browser task can also seed a DB).

### Contract delta (`@everdict/contracts`)

```ts
// A per-case seed for a purpose:"data" dependency store. Dataset-owned (the experiment INPUT).
export const StoreFixtureSchema = z.object({
  store: z.enum(["postgres", "redis", "minio"]),
  role: z.string().optional(),          // bind to a specific dependency when several share a store kind
  seed: z.union([                        // where the initial data comes from (mirror of RepoSource's shape)
    z.object({ inline: z.string() }),    //   inline SQL / commands (small fixtures)
    z.object({ ref: z.string() }),       //   ArtifactStore ref — SQL dump / RDB / bucket tarball (large fixtures)
  ]),
  format: z.enum(["sql", "redis-cmds", "objects"]).optional(), // default inferred from store
});

// eval-case.ts — additive, orthogonal to `env` (the target). Absent = today (no seed).
fixtures: z.array(StoreFixtureSchema).optional(),
```

### Seeding step (runtimes)

A new step between `ensureTopology` and the front-door drive, in each `TopologyRuntime` (or once in
`ServiceTopologyBackend.dispatch` before `drive`, delegating to a runtime `seed` helper):

1. Resolve the case's per-run wiring (`wiringVars` already gives the isolation slice: `schema=run_<id>`,
   `key_prefix=run-<id>`, `object_prefix=runs/<id>/`).
2. For each `fixture`, load it INTO that slice via the same exec path `store-binding.ts` already uses for tenant
   DDL/ACL (`psql` / `redis-cli` / `mc`). Postgres: `CREATE SCHEMA run_<id>; SET search_path`; apply the SQL. Redis:
   commands under the key prefix. MinIO: upload objects under the prefix.
3. Teardown drops the slice (the isolation namespace already scopes cleanup).

**Warm-pool efficiency preserved.** The store PROCESS stays warm (keyed `(spec, version, zone)` today); only the
per-case DATA slice is cold. Optional two-level optimization (later): when a whole dataset shares one fixture, seed
once per `(harness, dataset-fixture-hash)` and namespace per case on top — a second warm key. Called out here; not
required for the first cut. Silent caps (e.g. skipping a fixture too large to inline) must `log()`.

### Store-state grader (`@everdict/graders`)

A new grader family for world-state verdicts: after the drive, read the post-run slice and diff vs `expected`.

- Reuses the `Grader`/`GradeContext`/`Score` contract; marks `needsCompute` appropriately (it needs store access,
  not the agent compute).
- **Must be co-located with the store** — the portability lint's exact warning: an internal store URL does not reach
  a remote judge. This pairs with `judge-placement-locality.md`: place the grader near the store, read the slice,
  emit the score. `GradeContext` gains the slice coordinates (the same wiring the seed used) so the grader knows
  which schema/prefix to read.
- Observation delivery: the post-run store snapshot can ride the existing `ObservationDelivery` axis
  (`reference`/`sentinel`/`egress`) so the judged detail flows the same way browser snapshots do.

### Reproducibility

`RecordingSpec` already seals `spec/model/seed/env` (`packages/contracts/src/execution/recording.ts`). Seal the
**fixture hash** (and ref) into `recording.seed` so a run's initial world-state is audit ground truth and the run is
replayable (`replay.md`). A fixture is immutable data like the rest of the dataset — re-scoring never re-seeds
differently.

## P3 — `StoreSpec` (deferred / YAGNI)

The last code-coupling is the closed `store: z.enum(["postgres","redis","minio"])` + hardcoded `STORE_DEFS`. For a
non-default store (postgres 15, mysql, qdrant) promote it — the same evolution `CommandHarness`/`RuntimeSpec` made:

```ts
// A declarative store definition. The three built-ins remain as defaults (nobody is forced to define postgres).
export const StoreSpec = z.object({
  image: z.string(), port: z.number(), bootEnv: z.record(z.string()).optional(),
  connEnvTemplate: z.record(z.string()),          // {field} vocabulary → conventional keys
  isolationCaps: z.array(z.enum(["schema","key-prefix","object-prefix","thread_id"])),
});
```

This decouples the store DEFINITION from code (the runtime still only receives an image and runs a container — it
never learns "postgres"). **Do NOT** make stores a versioned registry entity like harness/dataset — most stores are
plumbing, so that adds indirection without decoupling. Inline `StoreSpec` (+ optional named ref) is enough. Defer
until a real non-default-store request lands.

## Sequencing & backward compatibility

1. **P1** — `purpose` defaults to `plumbing` → existing specs unchanged; `isolateBy` derivation is additive UI +
   an optional wizard default (contract enum untouched). Ship the wizard usability win first.
2. **P2** — `fixtures` optional → absent = today; the seed step is a no-op with no fixtures; the store grader is
   opt-in. This is the real new capability (data-as-condition).
3. **P3** — `StoreSpec` optional → the enum stays as sugar for the built-ins. Defer to demand.

Each phase keeps the live topology e2e green and reproduces today's dispatch when the new fields are absent.

## Open questions

- **`thread_id` presentation.** It is agent-managed isolation, not a physical partition. Should the wizard infer it
  from the front-door protocol (LangGraph-shaped) or offer an explicit "my agent isolates itself (thread id)" toggle
  under Purpose?
- **Fixture storage.** Reuse `ArtifactStore` + the case-env file mechanism for large seeds (SQL dumps, RDB, bucket
  tarballs)? Inline only for small SQL. Size threshold + object-store offload.
- **Grader slice coordinates.** Exact `GradeContext` extension so a co-located store grader receives the schema/
  prefix to read — mirror how the seed step resolves the slice.
- **Two-level warm key.** Is per-`(dataset-fixture-hash)` slice caching worth building in the first cut, or a
  follow-up once large shared fixtures appear?
- **Cross-runtime seed parity.** The seed exec path must behave identically on docker/k8s/nomad (same discipline as
  `dependencyInjectEnv`'s one pure renderer). Where does the shared seed logic live — a pure planner + a per-runtime
  exec adapter?

## Skills to update when implementing

Per "skills travel with the code": P1 touching contracts → update `core-contracts` skill's dependency notes and the
`topology` skill's dependency model; P2's store grader → `graders` + `evaluation` skills; the wizard → `web` skill.
This doc is the SSOT the code links back to.
