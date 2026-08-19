---
name: topology
description: Service-topology harnesses (multi-service + browser/OS target env) — HarnessSpec(service), warm-pool/shared-store/per-case efficiency, orchestrator-agnostic deploy (Nomad + K8s), OTel/MLflow trace ingestion. Use when implementing service harnesses, a TopologyRuntime, or trace pulling.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Service-topology harnesses

A harness can be a process (Claude Code) or a **deployed multi-service topology that acts on a target env**
(browser/OS). See `docs/service-harness.md`.

## The model
- `HarnessSpec(kind:"service")`: `services[]` (each `{image?, port?, needs, env?, model?, exec?}`; `env` = per-service static
  config — precedence store `connEnv` < `service.env` < runtime `storeEnv` < `dependencies[].inject`) + `dependencies[]`
  (shared stores) + `target` (browser+ext) + `frontDoor` + `traceSource`.
- **Host-exec services (`exec: {kind:"host", command, artifact?}`)** — the portable Windows-without-Docker contract: the
  program runs DIRECTLY on the node (no container, no image; `validateServiceExec` enforces the pairing, image pins are
  rejected for host slots). Nomad realizes it as a `raw_exec` per-service group (declared port RESERVED, not mapped;
  artifact fetched pre-start); K8s/Docker runtimes decline fail-fast (containers only). Capability derivation: a
  topology needs `docker` only if it has ≥1 CONTAINERIZED service (`topologyNeedsDocker`), so a pure-host `requires.os:
  windows` topology gates on `os-windows` alone — pre-fix it demanded a docker-capable Windows node, which is why an
  otherwise-fine native service could never place. Runners now probe+advertise `os-windows`/`os-macos`.
- **Dependency env injection (`dependencies[].inject`) — BYO store env names.** The store-side sibling of
  `service.wiring`: an image reading its store connection under its OWN keys (`VALKEY_URL`, `OBJECT_STORAGE_ENDPOINT`)
  maps them on the dependency (`{env, template?}`; template = `{field}` over the closed per-store vocabulary
  `STORE_INJECT_FIELDS` in contracts, unset = `{url}`; unknown field fails at register + deploy). Rendered by ONE pure
  renderer (`dependencyInjectEnv`, `packages/topology/src/deploy/inject-env.ts`) from the deployed store's structured `StoreValues`
  (docker/k8s build-time defaults · Nomad discovered endpoints · pool-minted creds via `StorePlan.storeValues`) in all
  3 builders, merged TOPMOST (a stale `service.env` literal must never shadow the deployed store — the
  `inject-shadowed-literal` portability warning flags such dead literals; a service.env value that hardcodes a bare
  container/store DNS `host:port` — e.g. `super-spica-redis:6379`, resolvable only under Docker's embedded DNS — is a
  `store-by-literal` warning that points the author at inject, since a foreign store name is neither loopback nor a
  declared peer so the older lints missed it). `external` deps reject inject (nothing
  deployed → no coordinates). One mapping ⇒ one harness works on every runtime/isolation — a literal can't even
  express pool creds. Never flatten store coordinates into env keys before BOTH renderings (conventional connEnv +
  inject) happen — early flattening is the exact rupture this closed.
- **`service.model` = a registered-Model binding** (`string | ModelRef`, `docs/models.md`). Set it on the service
  that runs the agent → `ModelResolvingDispatcher` (`apps/api`) injects that model's connection (baseUrl + underlying
  model + the API key from its `apiKeySecret`) into **that** service's env at dispatch, wins over a same-name literal,
  replacing a hand-wired `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`MODEL` combo. Provider-standard var names by default,
  overridable per binding (`ModelRef.env`). Peers (DB/proxy/browser) leave it unset.
- **Peer env interpolation (`interpolateServiceEnv`, `nomad-topology.ts`).** A `service.env` value may reference a
  `needs` peer with a `{{peer}}`/`{{peer.host}}`/`{{peer.port}}`/`{{peer.url}}` token. On the static-address runtimes —
  docker (alias), co-located Nomad (loopback), K8s (Service DNS) — it resolves **one pass at deploy time** (no waves:
  `alias:port` is known up front). Per-service Nomad (dynamic host ports) renders the token into the discovery **template**
  file so consul-template resolves it from the catalog at runtime (re-resolving, like `EVERDICT_SVC_<PEER>`). A peer not in
  `needs` / with no port → fail-fast `BadRequestError`; a token naming no service is left verbatim. The declarative sibling
  of `service.wiring` (BYO env names) — both use the same per-runtime `hostFor`. See `docs/service-harness.md`.
- A run = ensure warm topology → per-case browser → drive (front-door `POST /runs` with per-run wiring) →
  collect trace (OTel/MLflow) → observe (browser snapshot) → grade.
- **Cancellable**: `DispatchOptions.signal` threads into `dispatch` → the front-door driver, so a user "stop
  scorecard" aborts the in-flight submit/poll/stream/callback mid-flight (`CANCELLED`, freeing the socket) instead
  of draining the run; `dispatch`'s finally tears down the per-case browser (warm services stay). See `docs/scorecards.md`.

## Efficiency (the whole point)
stateless services = per-version warm; stores = shared + per-case logical isolation
(`thread_id`/key-prefix/object-prefix); browser = per-case. Wiring via the front-door, not a redeploy.
**A warm store is long-lived but the cases are ephemeral + independent** — so a store's TUNING is derived from its
ROLE, not baked as one global (`dependencies.ts` `resolveStoreConfig`/`storeArgs`; redis run args are COMPUTED, `STORE_DEFS.redis`
carries no static `args`). A **`plumbing`** redis (the agent's own per-case state) boots as an eval-CACHE —
`--maxmemory 200mb --maxmemory-policy allkeys-lru --save "" --appendonly no` — because on Redis defaults (maxmemory
0/noeviction + RDB `save` on) each case's streams accumulate → GB bloat → the periodic RDB fork stalls under VM
overcommit → control-state 500s; LRU reclaims a finished case's idle keys (active sessions stay hot → not evicted) and
`save ""`/AOF-off removes the fork (a cache has no durable state). A **`data`** redis (dataset-seeded world-state a
grader reads) is instead **DURABLE** (no-evict + persist), so eviction/loss never corrupts the ground truth — baking one
static cache array (the pre-model bug) applied the cache policy to data stores too. `TopologyDependency.storeConfig`
(`memoryMb`/`evictWhenFull`/`persistence`) overrides per store. Since the addressing model deploys **one instance per
store type**, multiple deps for it SAFETY-MERGE (durable/no-evict/unbounded wins → a plumbing+data pair coexists on one
instance without evicting the data); **cross-tenant pool** stores are always durable. True physically-separate same-type
instances with independent tuning is the singular-addressing follow-up.

## Store roles + data-as-condition (P2 — `docs/architecture/dependency-store-roles.md`)
- **`dependencies[].purpose`** = the store's role: `plumbing` (default — the agent's OWN state, empty at start,
  harness-owned) vs `data` (a world-state store the TASK operates on; its CONTENT is an experiment variable owned by
  the dataset). The wizard asks `purpose` + a 3-option `management` axis (managed / agent-isolated / external) and
  DERIVES `isolateBy` — authors never pick the raw 5-value enum. The contract enum is unchanged (runtime wiring vocab).
- **Seed** (`EvalCase.fixtures[]`, dataset-owned): the PURE `planStoreSeed` binds each fixture to a `purpose:"data"`
  store `(store, role?)`, validates it (rejects no-match / ambiguous / plumbing / external), and resolves the per-case
  slice. `ServiceTopologyBackend` resolves artifact-`ref` seeds to inline (`resolveSeedRef`), then calls
  **`TopologyRuntime.seedFixtures(spec, runId, plans, zone)`** AFTER `ensureTopology`, BEFORE the drive (a PRECONDITION
  — a failure or a runtime without the capability fails the run).
- **Grade** (`StoreStateGrader`, graders skill): reads the post-run slice via a co-located
  **`TopologyRuntime.readStoreState(spec, runId, query, zone)`** injected as `GradeContext.readStore` — an internal
  store URL can't reach a remote grader (`judge-placement-locality.md`).
- **Tune** (`resolveStoreConfig`/`storeArgs`): `purpose` also drives the store's CONFIG, not only seed/grade — `plumbing`
  → eval-cache, `data` → durable (see Efficiency above). This is why `purpose` is no longer "a semantic marker only": it
  now branches store deployment tuning across all 3 runtimes (the co-located path resolves from the real deps; silo
  passes the real-spec config; pool forces durable).
- **The exec is runtime-agnostic**: `buildSeedExec`/`buildReadExec` (pure, `store-seed.ts`) build the in-container
  command per store — postgres (schema slice via the connection's `search_path` startup option, NOT a `SET` that
  would echo into a read), redis + minio (`{prefix}` placeholder; redis via a redis-cli stdin heredoc, minio via `mc`
  with root creds). The `db` param carries the pool tenant DB. All 3 runtimes (Docker/K8s/Nomad) share them; each
  resolves silo (dedicated store, `everdict` DB) vs pool (shared store + `tenant_<slug>` DB) the SAME way the deploy
  did. Live-verified: `scripts/live/store-fixture-seed.mjs` (real postgres + minio).

## Orchestrator-agnostic
`ServiceTopologyBackend` (a `Backend`) holds a `TopologyRuntime`. Only the runtime differs:
`buildNomadTopologyJob` (Nomad) vs `buildK8sManifests` (K8s). Both pure + deterministic-tested.

## Live Nomad runtime
`NomadTopologyRuntime` implements `TopologyRuntime` against the Nomad API: `ensureTopology` registers the
warm service job, polls it to running, and discovers endpoints from the alloc via pure `resolvePort`
(`AllocatedResources.Shared.Ports` → `Resources.Networks`); `provisionBrowserEnv` runs a per-case headless
Chromium and discovers its CDP from `/json/version`. **Warm-cache liveness re-check:** each `ensureTopology`
cache hit re-verifies every service group still has a running alloc (one `/v1/job/:id/allocations` Get via
`topologyAlive`) — after a reschedule/purge the cached host:port is stale, so a poisoned entry is dropped and
redeployed instead of served forever (mirrors Docker's `docker ps` guard; a Nomad blip serves cached best-effort).
The warm entry stores `{handle, jobId, ns, groups}` for this.
**Resetting a warm topology (gap 3 — already an ops lever).** A per-`(id@version@zone)` teardown does not need a new
endpoint: the topology job is deterministically named `everdict-harness-<id>-<version>[-<zone>]` (`topologyJobId`), so
an admin `stopWorkload everdict-harness-<id>-<version>-<zone>` (the existing runtime-control ops action + MCP tool,
gated `runtimes:control`) deregisters the cluster job, and the warm-cache liveness re-check above then drops the now-
dead in-memory entry on the next `ensureTopology` and redeploys. So a poisoned/stale warm topology is cleared by
`stopWorkload` (durable, cluster) + the auto-heal (in-memory) — no control-plane restart, no dedicated teardown route.
**Topology-health diagnosis (A6).** `TopologyRuntime.diagnose?(spec, zone)` (Nomad implemented: alloc TaskStates →
"task: OOM-killed (exit 137), restarts=N" / restart churn) is appended best-effort to BOTH completion-timeout
failures in `service-backend` (message + `extra.topologyHealth`) — a service OOM loop no longer hides behind "the
agent did not finish within the budget". The batch-path twin: backends' `eventsIndicateOom` now also matches a bare
exit 137, K8s `podFailureReason` maps exit 137 → OOMKilled, and a missing `__EVERDICT_RESULT__` sentinel is explained
from the alloc task events (OOM → `OOM_KILLED` fatal-infra verdict) instead of the bare "could not find the agent result".
**Topology observability (structured, live).** `diagnose`'s STRUCTURED siblings on the port:
`TopologyRuntime.describeTopology?(spec, zone) → TopologyStatus` (wire SSOT `@everdict/contracts/wire` — the live
per-service roster: state/readiness/restart churn/OOM/last event; Nomad = topology-job alloc TaskStates [404 = an
honest `deployed:false`], K8s = `Kubectl.podStatuses?` per declared service, Docker = `docker ps` binary
running/absent) and `TopologyRuntime.serviceLogs?(spec, service, zone)` (one service's log tail; Nomad alloc task
logs stdout+stderr, K8s `Kubectl.logs?` on the service pod, Docker `Docker.logs?`). `ServiceTopologyBackend`
exposes them as the `TopologyInspectable` capability (`@everdict/backends` — harness-keyed, tenant→zone), served as
`GET /runs/:id/topology`(+`/services/:service/logs`) + MCP `get_run_topology`/`get_topology_service_logs` + the web
run detail's "Service topology" panel. All reads best-effort, never throw — readable WHILE a run drives the stack,
not only inside a timeout error. See `docs/architecture/live-observability.md` ⑧.
**The RECORD half — dispatch seals its own infra plane per case** (a topology case submits no orchestrator job, so
nothing else would): `service-backend.ts` marks `topology_ready → fixtures_seeded → target_acquired →
drive_submitted → drive_completed → trace_collected` as `infra` placement events, appends the roster AND each
unit's log tail (`serviceLogs`, `SERVICE_LOG_TAIL_CAP` per unit, empty skipped) at completion, and the two
completion-timeout throws carry the marks as `placement.events` failure evidence. Keep new dispatch stages marked
the same way — the sealed trajectory is the only account that survives the warm stack's churn/teardown.
**Warm-topology idle reclamation (A9).** `teardown()` is now ON the `TopologyRuntime` port and actually called: every
runtime (Nomad/K8s/Docker — isomorphic) stamps `lastUsedAt` on its warm entries (touched on each ensure) and
self-schedules an unref'd `sweepIdle(ttl)` interval (lazy-started on first ensure; defaults
`DEFAULT_WARM_IDLE_TTL_MS`=30 min / sweep 60s; opts `warmIdleTtlMs<=0` disables, `now` injectable). An entry idle past
the TTL is torn down best-effort (in-flight deploys are skipped); the next ensure simply redeploys. Because the
interval lives on the runtime INSTANCE, a superseded runtime/harness version (still in the backend registry, no
longer dispatched) also drains its warm jobs — pre-fix nothing ever called teardown, so version iteration exhausted
the cluster (browser sessions swept every 60s; topologies never).
**No-zone store parity:** declared `dependencies[]` must be provisioned on every runtime regardless of zone — Docker
always deploys them, K8s deploys when `provisionDependencies` is set, and Nomad now honors the SAME
`provisionDependencies` option for the no-zone case (deploys the stores as a dedicated silo under a `default` id via
`provisionSilo`, no tenant DDL). Without it, no-zone = `external` (BYO). Pre-fix Nomad no-zone deployed ZERO declared
stores (the isolation branch was gated on `if (zone)`).
**Co-located topology (Nomad only — see `docs/architecture/nomad-colocated-topology.md`).** `buildNomadTopologyJob`
renders **one task group** (`SERVICE_GROUP_NAME`) with **one task per service** on a **bridge** netns — every
service shares one network namespace, so peers talk over **loopback** (`localhost:<svc.port>`; `extra_hosts` also
maps each service **name** → `127.0.0.1` for `<svc.name>:<port>` docker/k8s parity). This ports the docker
runtime's fixed internal-address model: an inter-service address never depends on a dynamically-assigned host
port, so it never goes **stale** on reschedule (the whole topology reschedules atomically as one alloc — the fix
for the old per-service-group model's `fetch failed`). Each ported service still gets a group dynamic host port
(label = its sanitized name) for control-plane reach; `ensureTopology` waits for the one group's alloc **once**
and resolves each service by `servicePortLabel(svc.name)`. Shared netns ⇒ **ports must be unique** (throws
`BadRequestError` on a collision); per-service `replicas` is ignored (`Count 1`).
**Tenant isolation:** `ensureTopology`/`provisionBrowserEnv` take an optional `TrustZone`; the warm pool is keyed
by `(spec, version, zone.id)` and the job ID/namespace carry the zone — warm topologies are **never shared across
tenants** (a shared agent/LangGraph process would leak state/secrets). A tenant's co-located alloc has no route to
another tenant's; intra-tenant netns sharing is not a cross-tenant concern. **Consul Connect** inter-service mesh
(sidecars/upstreams) is obviated by co-location and removed from the builder; `buildTenantIntentions` stays as the
cross-tenant authorization decision (defense-in-depth / external gateway policy). Verified live on Nomad.

## Live K8s runtime
`K8sTopologyRuntime` is the same shape via an injectable `Kubectl` (default shells to `kubectl`):
`ensureNamespace` (per-tenant namespace = isolation) → `apply` Deployment+Service → `rollout status` → endpoint
via `kubectl port-forward svc/… :<port>` (parse the local port from stdout). `provisionBrowserEnv` runs a
headless-Chromium Deployment+Service; `dispose()` deletes only the browser (warm topology survives), `teardown()`
deletes the namespace. `imagePullPolicy`/`runtimeClass` are options (kind: pre-`kind load` images + IfNotPresent).
Verified live on kind — Nomad↔K8s parity. **Warm-cache liveness (gap 2, parity with Nomad):** each `ensureTopology`
cache hit re-verifies every ported service still has a pod (`podFor` scoped `everdict/harness`+`everdict/version`+`app`);
a dead set (ns/Deployment deleted) drops the cache and redeploys (K8s `apply` is idempotent, so a redeploy on a probe
blip merely re-adopts — no separate blip-vs-dead distinction needed, unlike Nomad).

## Local Docker runtime (self-hosted runner)
`DockerTopologyRuntime` (`docker-runtime.ts`) is the **third** `TopologyRuntime` — same shape as Nomad/K8s but on
the **user's Docker daemon** (injectable `Docker` adapter `docker.ts`, faked in tests). `ensureTopology` runs the
dependency stores + services on a per-topology network (`--network-alias` = the conventional name so
`dependencyConnEnv`/`needs` resolve internally; services publish their port → host port for the out-of-network
driver); `provisionBrowserEnv` runs headless-shell (`cdpUrl` = the **internal** alias for the agent, `snapshot()`
hits the **host** published port). It exists so the **self-hosted runner** can drive `kind:"service"` harnesses on
a laptop — a single-user host, so **no `TrustZone`/gVisor/pool-silo** (those stay for cluster runtimes). See
`docs/architecture/self-hosted-service-runner.md`.
- **Cross-process deploy coordination (adopt → cold-start mutex → heal).** Container/network names are deterministic
  (`everdict-<id>-<version>-…`), so every runner PROCESS on one daemon (desktop app + CLI runners) reaches the same
  names. `deploy` arbitrates atomically ON THE DAEMON, in order: ① **adopt** a fully-running, ready same-name set
  (`Docker.running` exact-name gate → one-shot store exec + ported-service HTTP probes) — never `docker rm -f`
  another process's live topology; ② **cold start** — `docker network create` is atomic, so exactly one process wins
  and deploys while losers wait-adopt within the readiness budget; ③ **heal** — a MAIMED set (some containers dead)
  is demolished + redeployed under a dedicated heal-lock network (`<network>.heal`, atomic create, stale locks
  expire by age) so concurrent healers can't collide on `docker run --name`; lock losers loop back and adopt.
  The warm cache also liveness-checks its container set each ensure (one `docker ps`) — dead-set entries are
  dropped and re-arbitrated instead of served forever (self-heal, verified by the live chaos suite).
- **Per-service declarative knobs (Docker honors them; Nomad/K8s ignore for now):** `TopologyService.volumes`
  (`string[]` → `docker -v` mount specs, named volume or bind mount) and `TopologyService.readiness`
  (`{timeoutMs,intervalMs}` → the HTTP endpoint readiness-poll budget; absent = the runtime default 60s/1s, also
  overridable globally via `DockerTopologyRuntimeOptions.readyTimeoutMs`/`pollIntervalMs` ↔ runner
  `--ready-timeout-ms`/`--ready-interval-ms`). All readiness polling routes through one `pollReady` helper.
- **Runner robustness — session re-init (`@everdict/self-hosted-runner` `runner-session.ts`).** The control plane holds MCP sessions
  in-memory, so an API restart orphans the runner's `mcp-session-id` (every call → 400/404 → the old loop wedged
  retrying a dead transport forever). `ResilientMcpSession` wraps every tool call: a `callTool` throw (transport/
  session error — app errors come back as `isError` results, no throw) drops the session and re-connects (fresh
  `initialize` → new session id) once before retrying; the poll loop's backoff covers repeat failures.

## Front-door generalization — driving is harness-agnostic (LANDED)
`ServiceTopologyBackend.dispatch` used to be hardcoded to one protocol (browser-use-langgraph): fixed payload,
fire-and-forget submit, trace-by-Everdict-runId, always-provisioned browser, fixed image. Each hardcode is now an
optional knob defaulting to that behaviour, declared by `FrontDoorSpec` and executed by `FrontDoorDriver` (the
harness-agnostic sibling of `TopologyRuntime`) — the whole surface lives in `packages/topology/src/front-door/`
and `service-backend.ts` drives through it. Read `docs/architecture/front-door-generalization.md` for the
reasoning before touching that driving logic.
- **Default submit is `node:http`/`node:https`, not global `fetch`.** undici's `headersTimeout` (default 300s) aborts
  `sync`-completion harnesses that hold the response for minutes while the agent runs; the raw node request has no such
  cap. `FrontDoorRequestOpts.timeoutMs` (from `completion.timeoutMs`) is applied as a **socket idle timeout**: while the
  server holds the response no data flows, so idle-time *is* the completion deadline. `sync.timeoutMs` is **optional**
  (unset = unbounded here — the per-case wall-clock below is the real cap; set = a tighter sync-specific idle cap).
  The submit socket also enables **TCP keepalive** so a peer that dies while holding the response open (no data, no FIN)
  is surfaced via keepalive probes rather than hanging. Socket errors remap to `UpstreamError`.
- **Per-case drive wall-clock (completion liveness).** `ServiceTopologyBackend.dispatch` bounds the WHOLE `driver.drive`
  by the declared per-case budget (`EvalCase.timeoutSec`) — an internal `AbortController` chains the dispatch signal
  (user stop) AND a deadline timer, so a dead/hung front-door (e.g. a `sync` agent whose command stream died) fails with
  an explicit `HARNESS_RUN_FAILED`/`completion-timeout` instead of hanging in `running` forever. Every other execution
  path already honors `timeoutSec`; this brings the topology drive to parity. Timer injectable via
  `startDriveDeadline` (test determinism). Follow-up: heartbeat-based *earlier* (sub-budget) stream-death detection.
- **#2 completion — DONE (5 modes).** `FrontDoorDriver`/`HttpFrontDoorDriver` (`front-door-driver.ts`) own submit +
  await; `frontDoor.completion` in `@everdict/contracts`: `sync` (default) | `poll` (`StatusMatch` done/failed) | `stream`
  (SSE submit; `OpenStreamFn`/`fetchStream`; terminal event via `StatusMatch`; first-event correlate) | `callback`
  (fire-and-forget → `CallbackRendezvous` awaits the agent's POST to `{{callback_url}}`; in-process rendezvous +
  control-plane `POST /frontdoor-callback/:runId`) | `trace` (the submit BLOCKS/returns nothing useful — completion =
  the run's trace reaching a terminal state; the driver fires the submit monitored-but-not-awaited [a rejection fails
  the drive on the next probe tick, never a silent budget burn] and polls an injected `TraceReadyFn` the backend builds
  from the pre-drive-resolved trace source [`TraceSource.status?` = MLflow `TraceInfo.state`, else presence]; `returned`
  correlate + `traceInline` are schema-rejected). dispatch fails a run on completion timeout.
  **Front-door failure truthfulness:** the submit PATH `{var}`-interpolates with wiring in every mode (a
  `{session_id}` path no longer reaches the agent as `%7B…%7D`); a non-2xx submit/stream rejects with status+body
  (never flows downstream as a bogus result); the poll GET fails fast on 4xx but keeps polling through 5xx; the
  session-open `fetchAcquire` surfaces HTTP failures instead of feeding the error body into coordinate mapping. See
  `docs/architecture/completion-stream-callback.md`.
- **#3 correlate — DONE.** `frontDoor.correlate` (`injected` default = Everdict runId | `returned` = extract the
  agent's own id from the submit response via `correlate.path` dot-path, used for both trace fetch and the poll
  `statusPath`). `SubmitFn` now returns the response body. Distinct from the still-dormant `frontDoor.trace` endpoint.
  **Two-axis correlation — for "the agent won't reliably carry OUR run_id".** Correlation is split across two specs by
  design: `frontDoor.correlate` decides WHICH id identifies the run (ours=`injected` or the agent's own=`returned`),
  and `traceSource.correlate` decides HOW to find that id on the platform (`id` = the run id IS the trace id, `tag` =
  search a span tag — `traceSource.correlateTag`, default `everdict.run_id`). The chosen id flows through
  `DriveOutcome.traceRef` into `traceSource.fetch(traceRef)` (`service-backend.ts`), so an agent that mints its own id
  (and overwrites our injected tag) is handled by `frontDoor.correlate:returned` + `traceSource.correlate:id|tag` — no
  separate trace-pull "returned" mode is needed (the returned id already reaches the pull). Reach for this whenever the
  agent can't be trusted to carry the injected key.
  **Controlled-coordinate correlate — when the agent OVERWRITES `everdict.run_id`.** If the agent replaces our injected
  `everdict.run_id` tag with its OWN internal id, BOTH `id`- and `run_id`-tag correlation miss. `frontDoor.contextId` (a
  `{{var}}`-interpolated template over the per-run vocabulary — e.g. `{{thread_id}}`, `run-{{run_id}}`) names a STABLE
  session/target coordinate everdict injects as the agent's session identity, which it can't overwrite (unlike a passive
  tag). When set, the trace is PULLED by that coordinate instead of `outcome.traceRef` (`service-backend.ts`), and
  `traceSource.correlate:"tag"` + `traceSource.correlateTag` (e.g. `mlflow.trace.session`) searches the SESSION tag the
  agent DID carry. `contextId` only names an already-injected coordinate — it adds no body field. This is the built form
  of the former "session correlate" idea (mlflow session-tag search); the tag-key generalization lives in the
  otel/mlflow adapters (`correlateTag ?? everdict.run_id`).
- **#1 payload template — DONE.** `frontDoor.request.bodyTemplate` (`interpolateTemplate` — recursive `{{var}}`
  over the JSON body); per-run wiring variable NAMES derive from `dependencies[].isolateBy` via `wiringVars`
  (`thread_id`/`key_prefix`/`object_prefix`/`schema`), not hardcoded LangGraph names. Absent `request` = today's body.
- **external (BYO) deps.** `dependencies[].isolateBy: "external"` declares a store the harness only **connects to**
  (other-cluster shared redis/minio/postgres). Everdict deploys/isolates nothing — `dependencyStores` skips it (no
  container, no `connEnv`) and `wiringVars` makes no isolation var; the connection comes from `storeEnv`/`service.env`.
  It exists for **visibility** (first-class node in the diagram/spec instead of a hidden env URL); optional `service`
  names the using service (diagram service→store edge). See docs/service-harness.md.
- **#4 target observation — DONE (none/everdict).** Browser provisioning is gated on `spec.target` (already optional,
  was ignored): absent → no browser, trace-only run with a `{kind:"prompt"}` snapshot (no core-contract change).
  A `harness`-provided target (a service's own session) is now the **target axis** (round 2) below — not a
  `TopologyRuntime.observe` method.
- **#5 per-service image pin — DONE.** `CaseJob.imagePins` (service name → image) overrides registered images at
  dispatch; `applyImagePins` (`image-pins.ts`) folds pins into a deterministic `-pin-<hash>` effective version so
  warm pools (id@version-keyed) separate variants with no runtime change; unknown service → `BadRequestError`.
- **All 5 core knobs landed** + completion `stream`/`callback` (round 3) + `request.headers`/`method`
  (`frontDoor.request.headers`, `{{var}}`-interpolated; method from `submit`'s verb). Follow-ups: store-backed
  callback rendezvous (multi-process), live A2A stream/callback e2e — see `docs/architecture/front-door-generalization.md`.

## Front-door conversations — `FrontDoorSession` (multi-turn, the playground's service lane)
`FrontDoorSession` (`front-door/front-door-session.ts`) is the MULTI-TURN sibling of `dispatch`'s one-case
drive slice: a member converses with a deployed service harness through its front-door. The continuity
contract — SESSION-stable (derived from the session run id): isolateBy wiring (`thread_id`/`key_prefix`/
`object_prefix`/`schema`), `stream_channel`/`minio_prefix`, and the target acquired ONCE at boot and held to
close (one browser per conversation); PER-TURN fresh: `run_id`, the trace correlation key, `callback_url`
(the rendezvous holds one waiter per key). One `thread_id` across submits is what makes a checkpointing agent
(LangGraph) resume — proven by `service-topology-aegra`. Rules: the session NEVER owns the runtime (it holds
the SHARED per-`rt:<tenant>:<id>@<version>` instance the eval lane dispatches with — one warm pool, one idle
sweeper; two instances would let one lane's sweeper kill the other's warm job mid-turn) and never calls
`teardown`; every turn re-calls `ensureTopology` (touch-on-use + heal); a session-stable `contextId` pulls the
CUMULATIVE trace, so turns return the delta past what was already seen; fixtures/observe/grade/recording are
deliberately absent (a conversation has no grading stage); trace-completion harnesses are refused (no reply to
converse with). apps/api binds it behind application-control's structural `ServiceConversation` port
(`composition/sandbox.ts` `resolveServiceConversation` → `topologyConversationEnvironmentFor` in
`composition/dispatch.ts`). See `docs/architecture/harness-playground.md` §Conversations.

## Target axis (round 2) — `TargetAcquirer` (B1+B2 DONE)
Round 1 left the **target** assumed to be "a CDP browser Everdict provisions." Round 2 generalizes it — the WHAT-target
seam, fourth sibling of `TopologyRuntime`/`FrontDoorDriver`/`ObservationSource`. Read
`docs/architecture/target-acquisition-generalization.md` before touching `target-acquirer.ts`/the dispatch target step.
- **B1 — handle is a coordinate bag.** `BrowserEnvHandle{cdpUrl}` → `TargetEnvHandle{ wiring: Record<string,string> }`
  (`snapshot` widened to `EnvSnapshot`); the 3 runtimes return `wiring:{ target_cdp_url }`; `dispatch` merges
  `...target.wiring`. So a `bodyTemplate` references **any** coordinate the target declares (`{{playwright_server_url}}`,
  `{{session_id}}`) — the wiring vocabulary is open, not the fixed `target_cdp_url`. Default body byte-identical.
- **B2 — `target.acquire` (`provision` | `service`).** `targetAcquirerFor(target, runtime, request)`: `provision`
  (default) delegates to `runtime.provisionBrowserEnv` (today); `service` = `serviceAcquirer` opens a declared
  service's session (`open` → `coordinates` dot-path map → wiring bag, `close` on dispose; HTTP only, lives by the
  `FrontDoorDriver`). No Everdict container → observation via `delivery` (`sentinel`/`egress`) or a `prompt` snapshot.
  Coordinate-mapping failure best-effort-closes the half-open session (no leak). Absent `acquire` = `provision`.
- **`acquire.ready` — session readiness gate.** A `service` session can exist before its client (the browser that
  back-connects) has self-registered — front-door commands then 404. Optional `acquire.ready`
  (`{service?, poll:"GET /path", intervalMs, timeoutMs}`) polls the status URL (injectable `ProbeFn`, default
  `fetchProbe` = 2xx?; path `{var}`-interpolated with wiring+coordinates, e.g. `{session_id}`) until 2xx **before**
  handing back coordinates. Timeout ⇒ best-effort `close` (no leak) then `UpstreamError`. Absent = no gate (today).
- **Target choice is `pickPageTarget` (`capture-cdp.ts`), never `targets[0]`.** Captures, the CDP recorder and the
  interactive session all route through it. It keeps the browser's most-recently-active ordering (the work-surface
  signal) and filters only blank tabs. Do NOT add a "skip `chrome-extension://`" rule: an extension-driven work tab
  IS an extension page until it navigates, so that rule selects the blank tab exactly when recording starts.
- **`acquire.capacity` — the pool the orchestrator cannot see.** A session pool lives INSIDE a service container,
  so the thing that actually limits a batch is invisible to placement: the roster reports a healthy service while
  every case beyond the pool size is refused. Declaring `{poll, total, used?}` puts it on `TopologyStatus.pool`
  (→ `GET /runs/:id/topology`, MCP, the web panel) AND makes it the Scheduler's **admission truth**: each dispatch
  records the warm topology's pool coordinates (`trackPool`), and `capacity()` aggregates the live pools from
  those recorded coordinates (TTL-cached `poolCacheTtlMs`, default 3s; **never deploys** — an unreachable pool is
  dropped from the probe set and re-recorded by the next dispatch). `total` follows the pool (scale the session
  service out → the next pump admits wider, no re-registration), `used` counts every session in it (conversation-
  lane sessions included), so a full pool queues in the Scheduler instead of over-admitting into case-by-case
  refusals — queue depth / backpressure / autoscaler signals become real for the topology lane.
  `RuntimeSpec.maxConcurrent` (threaded via `buildTopologyEnvironment`) clamps as the operator ceiling; until a
  pool is visible (nothing dispatched yet / no `acquire.capacity`), the static cap (`maxConcurrent ?? 8`) stands.
  Four consumers hang off the recorded pools: ① **per-harness admission** — `capacityFor(job)`
  (`CaseCapacityAware`) answers with THIS harness's pools only (pin variants together, the job's zone only), so
  the Scheduler sizes each harness by its own pool on a shared runtime and skips (HOL) a job whose pool is full;
  ② **the dispatch-side slot wait** — `awaitPoolSlot` parks a case in front of a full pool (`target_waiting`
  infra mark + `onWaiting`, bounded by `poolWait.timeoutMs` → 429 `RateLimitError`; saturation must never read
  as an outage — the spillover breaker ignores `RATE_LIMITED`); ③ **/metrics** — `poolStats()` (`PoolReporting`)
  feeds `everdict_topology_pool_total/used` gauges from the LAST reading (a scrape never probes); ④ **the
  actuation loop** — declaring `capacity.scale {min,max}` opts the SESSION service into replica scaling
  (`TopologyPoolAutoscaler`: demand = pool.used + that harness's queued backlog, sessions→replicas via the
  pool's per-replica ratio, upscale immediate / downscale after hysteresis) through
  `TopologyRuntime.serviceReplicas/scaleService` — K8s implements them (per-service Deployment + Service DNS);
  the Nomad co-located group deliberately does NOT (scaling it replicates the whole stack while discovery stays
  pinned to one alloc).
- **`acquire.cdpBase` — the session's watchable address.** A dot-path into the open response yielding a
  **control-plane-reachable** CDP base (NOT the agent-facing coordinate — that one is an internal alias). It fills
  `TargetEnvHandle.cdpBase`, which is the single switch behind the CDP environment recorder AND the live screen,
  and `ServiceTopologyBackend` publishes it per runId for the drive (`captureScreen` runs on another call stack and
  can otherwise only rediscover a browser the runtime itself provisioned). Observability never fails an eval:
  missing/malformed = no live view, recorded as an `infra` event on the trajectory. Absent = today (trace-only).

## Observation delivery (`HOW-observe`) — pluggable seam
*How* the observation reaches the grader/judge is now a third axis (sibling of `TopologyRuntime`=WHERE,
`FrontDoorDriver`=HOW-drive): `ObservationSource` (`observation-source.ts`). `TopologyTarget.delivery`
(`@everdict/contracts`, `.optional()`) selects `reference` (store-fetch, default = today's `snapshot()`/prompt) |
`sentinel` (inline via result channel) | `egress` (push to a `sink`) | `trace` (recover from the harness's own artifact
store via the trace). `dispatch` delegates to `observationSourceFor(spec.target?.delivery)` — all four modes wired.
**`sentinel`** reads the observation from the **result channel** (`DriveOutcome.response` — `sync` = submit response,
`poll` = the `done` status body) via `delivery.path?` (dot-path, `getField`). **`egress`** GETs the
`{run_id}`-interpolated `delivery.sink` (via `getJson`, default `fetchJson`; keyed by `outcome.traceRef`) — the agent
pushed there out of band. Both validate the result as an `EnvSnapshot` (malformed → explicit run failure).
**`trace`** is for a CONTAINERLESS service target (`target.acquire:"service"` — the agent owns its own browser/session,
everdict provisions none) that offloads its observation (screenshot/DOM) to its OWN object store and references it FROM
the trace: `reference` has no everdict stage to pull, and the agent inlined nothing (`sentinel`) nor pushed to an
everdict sink (`egress`). `dispatch` pulls the trace via `TraceSource.fetchDetailed` (whose evidence extraction resolves
the in-trace artifact refs to real bytes — `ArtifactStore.get`), and `traceObservationSource` synthesizes the browser
snapshot from that evidence via the shared pure `snapshotFromEvidence` (`@everdict/contracts`, the SAME evidence→snapshot
the pull-ingest path uses). No browser evidence → prompt fallback (never fails the run). Requires a `traceSource.mapping`
with evidence slots. Pairs with judge store-locality (co-locate the judge near the store) —
`docs/architecture/judge-placement-locality.md`.

## Reference impls
`packages/topology/src/{nomad-topology,nomad-runtime,k8s-topology,k8s-runtime,kubectl,service-backend,environment-manager}.ts`,
`packages/trace/src/{otel,mlflow,trace-source}.ts`. Live now: both NomadTopologyRuntime + K8sTopologyRuntime apply
+ per-case CDP browser (`scripts/live/service-topology-{nomad,k8s}.mjs`). Still Phase 2: real browser+extension
(headful+xvfb+`--load-extension`) & browser-use images, real OTel/MLflow span ingestion.
