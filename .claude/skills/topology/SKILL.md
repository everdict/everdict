---
name: topology
description: Service-topology harnesses (multi-service + browser/OS target env) — HarnessSpec(service), warm-pool/shared-store/per-case efficiency, orchestrator-agnostic deploy (Nomad + K8s), OTel/MLflow trace ingestion. Use when implementing service harnesses, a TopologyRuntime, or trace pulling.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Service-topology harnesses

A harness can be a process (Claude Code) or a **deployed multi-service topology that acts on a target env**
(browser/OS). See `docs/service-harness.md`.

## The model
- `HarnessSpec(kind:"service")`: `services[]` (each `{image, port?, needs, env?, model?}`; `env` = per-service static
  config — precedence store `connEnv` < `service.env` < runtime `storeEnv` < `dependencies[].inject`) + `dependencies[]`
  (shared stores) + `target` (browser+ext) + `frontDoor` + `traceSource`.
- **Dependency env injection (`dependencies[].inject`) — BYO store env names.** The store-side sibling of
  `service.wiring`: an image reading its store connection under its OWN keys (`VALKEY_URL`, `OBJECT_STORAGE_ENDPOINT`)
  maps them on the dependency (`{env, template?}`; template = `{field}` over the closed per-store vocabulary
  `STORE_INJECT_FIELDS` in contracts, unset = `{url}`; unknown field fails at register + deploy). Rendered by ONE pure
  renderer (`dependencyInjectEnv`, `deploy/inject-env.ts`) from the deployed store's structured `StoreValues`
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
Verified live on kind — Nomad↔K8s parity.

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

## Front-door generalization — making driving harness-agnostic (in progress)
`ServiceTopologyBackend.dispatch` was hardcoded to one protocol (browser-use-langgraph): fixed payload,
fire-and-forget submit, trace-by-Everdict-runId, always-provisioned browser, fixed image. The direction — a declarative
`FrontDoorProtocol` + a thin `FrontDoorDriver` (the harness-agnostic sibling of `TopologyRuntime`), each hardcode →
an optional knob defaulting to today — is in `docs/architecture/front-door-generalization.md`. Read it before
touching `service-backend.ts`'s driving logic.
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
- **#2 completion — DONE (4 modes).** `FrontDoorDriver`/`HttpFrontDoorDriver` (`front-door-driver.ts`) own submit +
  await; `frontDoor.completion` in `@everdict/contracts`: `sync` (default) | `poll` (`StatusMatch` done/failed) | `stream`
  (SSE submit; `OpenStreamFn`/`fetchStream`; terminal event via `StatusMatch`; first-event correlate) | `callback`
  (fire-and-forget → `CallbackRendezvous` awaits the agent's POST to `{{callback_url}}`; in-process rendezvous +
  control-plane `POST /frontdoor-callback/:runId`). dispatch fails a run on completion timeout. See
  `docs/architecture/completion-stream-callback.md`.
- **#3 correlate — DONE.** `frontDoor.correlate` (`injected` default = Everdict runId | `returned` = extract the
  agent's own id from the submit response via `correlate.path` dot-path, used for both trace fetch and the poll
  `statusPath`). `SubmitFn` now returns the response body. Distinct from the still-dormant `frontDoor.trace` endpoint.
  **Two-axis correlation — for "the agent won't reliably carry OUR run_id".** Correlation is split across two specs by
  design: `frontDoor.correlate` decides WHICH id identifies the run (ours=`injected` or the agent's own=`returned`),
  and `traceSource.correlate` decides HOW to find that id on the platform (`id` = the run id IS the trace id, `tag` =
  search the `everdict.run_id` span tag). The chosen id flows through `DriveOutcome.traceRef` into
  `traceSource.fetch(traceRef)` (`service-backend.ts`), so an agent that mints its own id (and overwrites our injected
  tag) is handled by `frontDoor.correlate:returned` + `traceSource.correlate:id|tag` — no separate trace-pull "returned"
  mode is needed (the returned id already reaches the pull). Reach for this whenever the agent can't be trusted to carry
  the injected key. (A dedicated `session` correlate — pull by a session/thread key — is a niche future axis, unbuilt.)
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

## Observation delivery (`HOW-observe`) — pluggable seam
*How* the observation reaches the grader/judge is now a third axis (sibling of `TopologyRuntime`=WHERE,
`FrontDoorDriver`=HOW-drive): `ObservationSource` (`observation-source.ts`). `TopologyTarget.delivery`
(`@everdict/contracts`, `.optional()`) selects `reference` (store-fetch, default = today's `snapshot()`/prompt) |
`sentinel` (inline via result channel) | `egress` (push to a `sink`). `dispatch` delegates to
`observationSourceFor(spec.target?.delivery)` — all three modes wired. **`sentinel`** reads the observation from the
**result channel** (`DriveOutcome.response` — `sync` = submit response, `poll` = the `done` status body) via
`delivery.path?` (dot-path, `getField`). **`egress`** GETs the `{run_id}`-interpolated `delivery.sink` (via `getJson`,
default `fetchJson`; keyed by `outcome.traceRef`) — the agent pushed there out of band. Both validate the result as an
`EnvSnapshot` (malformed → explicit run failure). Pairs with judge store-locality (co-locate the judge near the
store) — `docs/architecture/judge-placement-locality.md`.

## Reference impls
`packages/topology/src/{nomad-topology,nomad-runtime,k8s-topology,k8s-runtime,kubectl,service-backend,environment-manager}.ts`,
`packages/trace/src/{otel,mlflow,trace-source}.ts`. Live now: both NomadTopologyRuntime + K8sTopologyRuntime apply
+ per-case CDP browser (`scripts/live/service-topology-{nomad,k8s}.mjs`). Still Phase 2: real browser+extension
(headful+xvfb+`--load-extension`) & browser-use images, real OTel/MLflow span ingestion.
