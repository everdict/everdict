---
kind: wiki
title: "Service-topology harnesses"
status: current
updated: 2026-09-16
anchors: [packages/contracts/src/harness/harness-spec.ts, packages/topology/src/deploy/topology-runtime.ts, packages/contracts/src/infra/trust-zone.ts, packages/topology/src/deploy/store-binding.ts, packages/topology/src/deploy/inject-env.ts]
---
# Service-topology harnesses

A harness can be a single process (`process`), any CLI (`command`, see [command-harness.md](command-harness.md)), OR a
**multi-service topology that acts on a target environment** (`service`). Example: **browser-use-langgraph** =
{agent-server (LangGraph; front-door), browser-mcp, action-stream} + {Postgres checkpoints, Redis stream, MinIO
snapshots} + a per-case Chromium, optionally loading a client browser extension. The first-party preset is `bu`
(`examples/harness-templates/bu.template.json` + `examples/harness-templates/bu-1.1.0.instance.json`).

## Spec (`HarnessSpec`, kind: "service")

Defined by `ServiceHarnessSpecSchema` in `packages/contracts/src/harness/harness-spec.ts`:

- `services[]` (per-version warm) — each `{name, image?, port?, needs, perRun, replicas, env, exec?, wiring?,
  requires?, readiness?, resources?, model?, volumes?}`. `env` is per-service static config (a literal or a
  `{secretRef}`, resolved just before execution).
- `dependencies[]` — `{store: postgres|redis|minio, role, purpose: plumbing|data, isolateBy, service?, inject?,
  storeConfig?}`; `isolateBy` is `thread_id | key-prefix | object-prefix | schema | external`. `purpose` and
  `storeConfig` are described in [dependency-store-roles.md](architecture/dependency-store-roles.md).
- `target?` — `browser | api | os` (below).
- `frontDoor` — `{service, submit, trace?, request?, completion?, correlate?, contextId?, traceInline?}` (below).
- `traceSource` — `{kind: otel|mlflow|langfuse|langsmith|phoenix, endpoint, authSecret?, correlate?: id|tag,
  correlateTag?, service?, project?, mapping?, artifactBaseUrl?}`.

**Host-exec services (`exec: {kind: "host", command, artifact?, provision?}`)** — the no-Docker realization: the
program runs directly on the node (Nomad `raw_exec`, in its own per-service group; the declared `port` is reserved,
not dynamically mapped; `artifact` is fetched into the task dir before start). A host service omits `image`
(`validateServiceExec` enforces the pairing on the services array). The Docker and K8s runtimes reject host services
fail-fast (containers only). `exec.provision: {command, key?}` renders as a Nomad **prestart task** in the host
service's group; `key` (default: derived from the command + artifact) is what makes a changed preparation re-run.
Capability-wise a topology needs `docker` only if it has at least one containerized service (`topologyNeedsDocker`),
so a pure-host `requires.os: windows` topology places on any `os-windows` node, and self-hosted runners probe
`os-windows` from their own platform.

Service env precedence: store `connEnv` (conventional) < `service.env` (author) < runtime `storeEnv` (operator
override) < `dependencies[].inject` (BYO store env names — rendered from the deployed store, nothing shadows it).

**Dependency env injection (`dependencies[].inject`) — BYO store env names.** The store-side sibling of
`service.wiring`: an unmodified third-party image that reads its store connection under **its own** env keys
(`VALKEY_URL`, `OBJECT_STORAGE_ENDPOINT`, …) declares, on the dependency, which keys it reads and how to compose them —
`inject: [{env: "VALKEY_URL", template: "valkey://{userinfo}{host}:{port}"}]` (`template` unset = the canonical
`{url}`). The `{field}` vocabulary is **closed per store kind** (`STORE_INJECT_FIELDS` in `@everdict/contracts`:
postgres `host/port/endpoint/url/user/password/userinfo/database`, redis `…/keyPrefix`, minio
`…/accessKey/secretKey/bucket`); an unknown field fails at registration (schema `superRefine`) AND at deploy
(`renderInjectTemplate`, for registry-bypassing paths). Values come from the **structured coordinates of the store the
runtime actually deployed** (`StoreValues` — docker alias / K8s Service DNS at build time, Nomad discovered
host:port, pool-minted per-tenant creds from `planTenantStores`), so ONE mapping works unchanged across
docker/nomad/k8s and pool/silo. A field the isolation model didn't mint renders empty (`{userinfo}` on an open silo
redis → "" but "user:pw@" under pool). Rendered **topmost** in the env merge by one shared renderer
(`dependencyInjectEnv`, `packages/topology/src/deploy/inject-env.ts`) called by all three builders; the portability
lint warns on a `service.env` literal under the same key (`inject-shadowed-literal`). `isolateBy: "external"` deps
reject `inject` (Everdict deployed nothing); their connection stays `storeEnv`/env. Scoped by the dependency's
`service` field (unset = every service).

**Peer env interpolation.** A `service.env` value may reference a `needs` peer's endpoint with a `{{peer}}` token —
`{{planner}}` / `{{planner.url}}` → `http://planner:8000`, `{{planner.host}}` → the host, `{{planner.port}}` → the port
(double-brace, same convention as the front-door `bodyTemplate`). `interpolateServiceEnv` resolves them **one pass at
deploy time** where a peer's address is static — docker (network alias), co-located Nomad (loopback name), K8s (Service
DNS). Per-service Nomad has dynamic host ports, so a `{{peer}}` value is rendered into the discovery **template** file
instead (consul-template resolves it from the Nomad-native catalog at runtime, re-resolving on reschedule — the same
mechanism as `EVERDICT_SVC_<PEER>`). Referencing a peer not declared in `needs` (or one with no port) is a
**fail-fast** `BadRequestError`; a `{{token}}` that names no declared service is left verbatim. `service.wiring` is the
sibling for third-party images: it fills the image's expected var names (`hostEnv`/`portEnv`/`urlEnv`) with the same
per-runtime address.

### Front door

`ServiceTopologyBackend` drives the agent through a `FrontDoorDriver` (default `HttpFrontDoorDriver`,
`packages/topology/src/front-door/front-door-driver.ts`). Every knob is optional and defaults to the original
browser-use behaviour:

- `request` — `bodyTemplate` (`{{var}}`-interpolated from the per-run vocabulary), `headers`, `encoding: json|form`,
  `files` (multipart attachments from the case env). Unset = the default body.
- `completion` — `sync` (default) | `poll` (status endpoint + `done`/`failed` matchers) | `stream` (SSE) |
  `callback` (the agent POSTs to `{{callback_url}}`) | `trace` (the pulled trace reaching a terminal state).
- `correlate` — `injected` (default: Everdict's run id) | `returned` (a dot-path into the submit response).
- `contextId` — a controlled coordinate (e.g. `{{thread_id}}`) the trace is pulled by instead of the run id; pair it
  with `traceSource.correlate: "tag"` + `correlateTag`.
- `traceInline` — see Inline trace below. `completion: trace` refuses `correlate: returned` and `traceInline`.

Design record: [front-door-generalization.md](architecture/front-door-generalization.md),
[completion-stream-callback.md](architecture/completion-stream-callback.md).

## Efficiency (orchestrator-agnostic)
- stateless services → **per-version warm pool** (per trust zone; idle warm topologies are reclaimed by `sweepIdle`)
- Postgres/Redis/MinIO → **shared**, isolated per case by `isolateBy` (thread_id / key-prefix / object-prefix / schema)
- browser → **per-case** fresh instance — the default `chromedp/headless-shell` image (pinned by digest,
  `packages/topology/src/deploy/browser-image.ts`, overridable per runtime as `browserImage`), or, when
  `target.extension.ref` is declared, that headful browser+extension image run as-is (Docker and Nomad runtimes)
- per-run wiring (`run_id`, the isolateBy vars, `target_cdp_url`, …) is injected via the front-door request to the
  **warm** agent — not a redeploy.
- **`perRun` = which per-run coordinates the default body carries by name.** A per-version-warm service cannot take
  per-run **env**, so per-run coordinates travel through the front-door request. When there is no `bodyTemplate`, the
  front-door service's `perRun` names are resolved from the per-run vocabulary (`perRunVocabulary`: the wiring vars plus
  `thread_id` / `stream_channel` / `minio_prefix`) and injected into the default body; a declared name the vocabulary
  can't deliver is a fail-fast config error. A `bodyTemplate` is explicit, so `perRun` is not injected there.
- **Host model-gateway reachability.** Services that call a host-local model gateway (LiteLLM etc.) address it as
  `http://host.docker.internal:<port>`. The Docker paths (`DockerTopologyRuntime`, `DockerDriver`) always add
  `--add-host host.docker.internal:host-gateway`. Nomad and K8s add the alias only when the runtime sets
  `hostGatewayAddr` to a concrete IP (e.g. `"172.17.0.1"` → Nomad `extra_hosts` / a K8s pod `hostAliases` entry):
  the `host-gateway` keyword is not an address, and Nomad's docker driver rejects the task over it.

## Topology runtimes (Docker, Nomad, K8s)

`ServiceTopologyBackend` (`packages/topology/src/service-backend.ts`, a `Backend`) is orchestrator-agnostic; only the
`TopologyRuntime` port (`packages/topology/src/deploy/topology-runtime.ts`) differs: `ensureTopology` (warm, per zone),
`provisionBrowserEnv` (per case), and optional `teardown`, `sweepIdle`, `diagnose`, `describeTopology`, `serviceLogs`,
`seedFixtures`, `readStoreState`, `browserCdpBase`, `serviceReplicas`/`scaleService`. Implementations:
`DockerTopologyRuntime`, `NomadTopologyRuntime`, `K8sTopologyRuntime`.

### `NomadTopologyRuntime`
- `buildNomadTopologyJob(spec)` renders a Nomad **service** job. A homogeneous, single-instance Linux container
  topology is **one co-located task group** (`everdict-services`): all services share a `bridge` netns and talk over
  `localhost:<svc.port>`; `extra_hosts` maps each service name → `127.0.0.1` for `<svc.name>:<port>` docker/k8s
  parity; each ported service gets a group dynamic host port (label = `servicePortLabel(name)`) so the control plane
  can reach it; ports must be unique (`BadRequestError` on a collision). See
  [nomad-colocated-topology.md](architecture/nomad-colocated-topology.md).
- A topology that is heterogeneous (a service requires a non-Linux OS), scaled (`replicas > 1`) or carries a
  host-exec service switches to **per-service groups** (`needsPerServiceGroups`); peers then find each other through
  the Nomad-native service catalog (`EVERDICT_SVC_<PEER>` + the consul-template env file).
- `ensureTopology` registers the job, waits for the alloc, and discovers each endpoint with
  `resolvePort(alloc, servicePortLabel(name))`; warm entries are cached per `id@version@zone`. The isolation runtime
  (e.g. `runsc`) is a runtime option.
- `provisionBrowserEnv` registers a per-case browser job, discovers its CDP port, and returns a `TargetEnvHandle`
  (`wiring.target_cdp_url`, `cdpBase`, `snapshot()`, `dispose()`).

### `K8sTopologyRuntime`
Same shape against the Kubernetes API, via an injectable `Kubectl` (default shells to `kubectl`):
- `ensureTopology(spec, zone)` → `ensureNamespace` (per-zone namespace, default prefix `everdict-`, labelled
  `everdict/managed=true`) → apply `buildK8sManifests` (Deployment + Service per service) → `rolloutStatus` →
  **discover endpoints** via `kubectl port-forward svc/…`. Cached per `id@version@zone`.
- Without a trust zone, `provisionDependencies: true` deploys the declared `dependencies[]` as a dedicated silo
  (`STORE_DEFS`: `postgres:16-alpine`, `redis:7-alpine`, minio) with services auto-wired to the in-cluster Service
  DNS (`DATABASE_URL`, `REDIS_URL`/`REDIS_URI`); `false` = external (BYO via `storeEnv`). An explicit `storeEnv`
  overrides the auto-wired vars.
- `provisionBrowserEnv(spec, runId, zone)` → `buildBrowserManifests` → rollout → port-forward CDP → `TargetEnvHandle`.
  `dispose()` deletes only the browser Deployment/Service; `teardown()` deletes the namespace.
- `runtimeClass` (gVisor), `imagePullPolicy`, `registryAuths` and `networkPolicies` are runtime options. K8s is the one
  runtime that implements `serviceReplicas`/`scaleService` (elastic session pools).

### Wired into the control plane
A `nomad` or `k8s` `RuntimeSpec` that carries a `traceSource` hosts topology harnesses (`topologyConfig` in
`packages/contracts/src/infra/runtime-spec.ts` — the separate `topology` runtime kind was removed in slice 5b-2).
`buildRuntimeBackend` (`@everdict/backends`) refuses to build those — it cannot depend on `@everdict/topology` — so
`apps/api/src/core/execution/topology-backend.ts` builds the live runtime, the trace source and the
`ServiceTopologyBackend`, whose `specFor` rejects any harness that is not `kind: "service"`. The workspace trace-source
registry (`/workspace/trace-sources`, selected per harness with `PUT /harnesses/:id/trace-source`) overrides the
runtime's fixed `traceSource` (`traceSourceFor`).

## Multi-tenant store isolation — pool / silo / external (`TrustZone.storeIsolation`)
The per-case `isolateBy` is **not a tenant boundary** — it isolates one tenant's own cases from each other. The
tenant boundary is the **database / role / credentials** (+ network). Three nested layers: **physical store fleet** →
**per-tenant logical namespace** → **per-case isolateBy**. `TrustZone.storeIsolation`
(`packages/contracts/src/infra/trust-zone.ts`) selects the model, planned by `planTenantStores`
(`packages/topology/src/deploy/store-binding.ts`):

- **`pool`** (default for `trusted` zones) — one platform-managed **shared** store per type (K8s namespace
  `everdict-shared`; Nomad job `everdict-shared-stores`), with per-tenant **logical** isolation: Postgres gets a
  `tenant_<zone>` **database** + a non-superuser `r_<zone>` **role** (with `REVOKE CONNECT … FROM PUBLIC`); Redis gets
  an **ACL user** scoped to `~t:<zone>:*`; MinIO gets a per-tenant **access key** + a `tenant-<zone>` **bucket** + a
  bucket-scoped **policy** (minted via `mc` inside the minio pod). Services receive the scoped creds. Minting runs
  through `kubectl exec` (K8s) or `nomad alloc exec` (Nomad) — only cheap logical objects, never a store engine per run.
- **`silo`** (default for untrusted zones) — a **dedicated** store instance per zone (K8s: the zone namespace; Nomad:
  `buildDedicatedStoreJob`, discovered host:port injected with default creds).
- **`external`** — BYO endpoint via `storeEnv`; Everdict deploys no store.

Default when a zone doesn't set it: `trusted → pool`, otherwise `silo`. Pool passwords are
HMAC(secret, `zone:store`) — deterministic, so re-provisioning is idempotent; the runtime's `storeSecret` is the seed
(production sources it from a KEK/Vault). On K8s the store endpoint is a build-time Service DNS; on Nomad the runtime
discovers the alloc `host:port`.

### Per-dependency `isolateBy: "external"` (spec-level BYO declaration)
A single dependency can be declared external in the spec itself: `{ store, role, isolateBy: "external", service? }`.
Everdict does **not** deploy or per-case-isolate it, and its connection comes from deploy-time `env`/`storeEnv`.
The runtime excludes it from provisioning and wiring (`dependencyStores` skips it; `wiringVars` makes no isolation
variable). Declaring it surfaces the store as a first-class node in the topology diagram; `service` names the service
that uses it (unset = topology-wide).

## Network isolation (`TrustZone.network`)
Per-tenant credentials stop a tenant from *reading* another tenant's data; `TrustZone.network`
(`deny-cross-tenant` default | `deny-egress` | `open`) closes the network layer.

**K8s — NetworkPolicy.** `buildZoneNetworkPolicies` / `buildSharedStoreIngressPolicy`
(`packages/topology/src/deploy/network-policy.ts`), applied by `K8sTopologyRuntime`:
- **`deny-cross-tenant`** — a zone-namespace ingress policy allowing only same-namespace sources; applied to every
  zone, so tenant A cannot initiate a connection into tenant B's namespace.
- **`deny-egress`** — adds an egress policy allowing only DNS + same-namespace + the pool store namespace +
  `egressAllowCIDRs` (and the resolved `modelEndpoints`).
- **`open`** — no policies.

The pool store namespace gets an ingress policy allowing only `everdict/managed=true` namespaces on the store ports.
`kubectl port-forward` (endpoint discovery, front-door submit) goes control-plane → kubelet → pod and is unaffected.
Enforcement needs a policy CNI — kindnet applies NetworkPolicy but does not enforce it; see the verification record.

**Nomad — Consul intentions.** A co-located topology is one alloc/netns with no route to another tenant's, so
cross-tenant isolation is the per-`(spec, version, zone)` job/netns separation. Given a `consul` client,
`NomadTopologyRuntime` also applies `buildTenantIntentions` (per destination `t-<zone>-<svc>`: allow same-tenant mesh
services, deny `*`) in `ensureTopology`, an `allow *` intention for shared stores, and deletes them in `teardown` — the
authorization decision, not an inter-service data-plane gate (co-located peers talk over loopback).
`buildNomadTopologyJob` does not wire Connect sidecars; `buildConnectService` remains a standalone building block for
`scripts/live/connect-enforce-nomad.mjs`, where a clean data-plane allow/deny differential was **not** demonstrated on
a single-node dev agent (Nomad advertised the sidecar at `127.0.0.1`).

## Trace (`@everdict/trace`)
The harness emits a trace to an observability platform; Everdict **pulls** it through a `TraceSource`
(`packages/trace/src/sources/`: `OtelTraceSource`, `MlflowTraceSource`, `LangfuseTraceSource`,
`LangsmithTraceSource`, `PhoenixTraceSource`, built by `buildTraceSource`) → `spansToTraceEvents` → normalized
`TraceEvent[]`. The mapper reads OTel GenAI keys (`gen_ai.request.model`, `gen_ai.usage.input_tokens`/`output_tokens`/
`cost`) **and** MLflow-native fallbacks (`mlflow.llm.model`, `mlflow.chat.tokenUsage`, `mlflow.llm.cost`), with a
per-harness span-attribute `mapping` for anything else. `OtelTraceSource` reads a Jaeger query response
(`GET /api/traces/{id}`, `parseJaegerSpans`) or OTLP-native spans (`parseOtlpSpans`); `MlflowTraceSource` reads
`GET /api/3.0/mlflow/traces/get?trace_id=` (and `traces/search` for `correlate: "tag"`).

**Trace-source failures don't kill the run.** `ServiceTopologyBackend.dispatch` catches a fetch (or inline extract)
failure and records it as a single stamped `error` `TraceEvent`; grading proceeds over the snapshot.

### Inline trace (no observability platform) — `frontDoor.traceInline`
When a service harness sets `frontDoor.traceInline: { path?: "trace" }`, the agent returns its step trace as a
**normalized `TraceEvent[]` inside the front-door response body**, and `ServiceTopologyBackend` extracts it with
`extractInlineTrace` (dot-`path`, or the whole body) instead of pulling from `traceSource`. Each element is validated
against `TraceEventSchema`; a malformed body is downgraded to a non-fatal `error` event. Unset = pull from `traceSource`.

**Inline `t` semantics — milliseconds from the drive's start.** An inline event's `at` (absolute ISO instant) is
preferred when the agent stamps it; otherwise its relative `t` is read as ms from the moment the front-door drive was
submitted. The backend declares that anchor on the result (`CaseResult.traceT0`), the sealer stores it as the
execution segment's `t0`, and the trajectory viewer lays the agent's steps on the same wall-clock axis as the placement
marks.

## Grading (browser/service)
`ServiceTopologyBackend` grades over `{trace, snapshot}` with `makeGradersFromEnv(evalCase.graders)` when the case names
graders (trace-based `steps`/`cost`/`latency` by default): browser-outcome (`dom-contains`, `url-matches` over the
`BrowserSnapshot`), and the model judge (`judge` → `JudgeGrader`, LLM/VLM over task + DOM/screenshot). Without a
configured judge model the judge grader yields a skip score instead of failing the eval; the lower-level
`makeGraders(specs, { judge })` throws when no `Judge` is injected.

### Target kinds — `browser` | `api` | `os`
`target` is a discriminated union (`TopologyTargetSchema`). `browser`: engine, lifecycle, `extension`, saved
`profile`, `observe`, `delivery`, `acquire`. `api`: a static `baseUrl` (wired to the agent as `target_base_url`) or one
acquired through a session API, plus an optional OpenAPI reference and auth secret. `os`: a desktop acquired only
through a session API. `targetDefects` refuses a target that cannot be obtained where the spec enters. A `command`
harness may declare a static `api` target, which reaches the CLI as `{{target.baseUrl}}` / `EVERDICT_TARGET_BASE_URL`.
An api client's exchanges are not observed from the target: a non-empty `observe` on an `api` target is refused, and
observation is declared on the environment (`EnvironmentSpec.observe.from`, fetched after the drive as a world
recording) — see [world-and-engagement-model.md](architecture/world-and-engagement-model.md) and
[harness-definability-spec.md](architecture/harness-definability-spec.md) §1.

### Target acquisition (`target.acquire`)
*How* the per-case target is acquired is the `TargetAcquirer` seam (`targetAcquirerFor`,
`packages/topology/src/front-door/target-acquirer.ts`); absent = **`provision`**. The per-case handle is a
`TargetEnvHandle` — a **bag of named coordinates** (`wiring`) merged into the per-run wiring, so a `bodyTemplate` can
reference any of them.
- **`provision`** (default) — the runtime spins a per-case browser and returns `wiring: { target_cdp_url }`.
- **`service`** — the target comes from a **declared topology service**'s session API (`serviceAcquirer`): `open`
  (e.g. `POST /sessions`) opens a session, `coordinates` (wiring name → response dot-path) fill the wiring bag, and
  `close` (e.g. `DELETE /sessions/{session_id}`) tears it down on `dispose()`. A coordinate-mapping failure
  best-effort-closes the half-open session. Optional: `cdpBase` (a control-plane-reachable CDP base — turns on the
  environment recorder and `GET /runs/:id/screen`), `capacity` (the pool read, with `scale` bounds), `wait` (queue on
  409/429 instead of failing), and `ready` (poll until the session's client registered).

See [target-acquisition-generalization.md](architecture/target-acquisition-generalization.md).

### Observation delivery (`target.delivery`)
*How* the observation reaches the grader is the `ObservationSource` seam (`observationSourceFor`,
`packages/topology/src/front-door/observation-source.ts`). It is read from a **browser** target only; api and os
targets observe by reference. Absent = **`reference`**:
- **`reference`** — pull the provisioned target's `snapshot()` (or a `{kind:"prompt"}` snapshot when there is no
  target).
- **`sentinel`** — the observation comes back inline in the front-door response (`DriveOutcome.response`);
  `delivery.path?` is a dot-path into it, validated as an `EnvSnapshot` (malformed → explicit run failure).
- **`egress`** — the agent pushes the observation to a `{run_id}`-interpolated `sink` URL and Everdict GETs it.
- **`trace`** — for a containerless target whose agent offloads screenshot/DOM to its own artifact store and
  references it from the trace; the trace source's evidence extraction resolves those references into the snapshot.

Pairs with judge placement — see [judge-placement-locality.md](architecture/judge-placement-locality.md).

## Real OSS harness e2e — aegra (self-hosted LangGraph)
**[aegra](https://github.com/aegra/aegra)** is an OSS self-hosted LangGraph server (FastAPI + **Postgres**
checkpoints + **Redis** + **Agent Protocol** HTTP API). It maps 1:1 to `HarnessSpec(service)`: `agent-server` (aegra) +
a `postgres` checkpoints dependency isolated by **`thread_id`** + an HTTP front door (Agent Protocol: assistant →
thread → run). Driver/grader: `scripts/live/aegra-langgraph.mjs`.

Recipe (host LiteLLM on `:4000`):
```
git clone https://github.com/aegra/aegra && cd aegra
# .env: OPENAI_API_KEY=<litellm key>, OPENAI_BASE_URL=http://172.17.0.1:4000, MODEL=openai/gpt-5.4-mini
docker compose up -d --build
docker network connect bridge aegra-aegra-1   # only the default docker bridge (172.17.0.1) reaches the
                                              # host's host-network LiteLLM (compose/kind subnets are blocked)
node scripts/live/aegra-langgraph.mjs
```
Gotchas: use the **`gpt-5.4-mini` alias** (no `chatgpt/` prefix — else litellm turns it into a ChatGPT-OAuth
device-code login that hangs in containers); the harness reaches the host LiteLLM only via the default bridge gateway
`172.17.0.1`.

`scripts/live/service-topology-aegra.mjs` runs a real `EvalCase` through `ServiceTopologyBackend` against aegra using
only the backend's injection points (`runtime` / `submit` / `traceSource` / `graders`); the `runtime` points at the
already-running aegra instead of deploying it.

### With a real browser environment (browser-use-langgraph shape)
`scripts/live/service-topology-aegra-browser.mjs` adds the per-case browser target: a `chromedp/headless-shell` CDP
browser, a LangGraph `browser_agent` graph in aegra (`scripts/live/aegra-browser-agent/graph.py`, Playwright
`connect_over_cdp`) that drives it, and Everdict snapshotting the same browser to grade the final URL and the answer.

aegra setup for the browser graph: copy `scripts/live/aegra-browser-agent/` into aegra's `examples/browser_agent/`,
register `"browser_agent": "./examples/browser_agent/graph.py:graph"` in `aegra.json`, `pip install playwright`
(as root; `connect_over_cdp` needs no browser binary), restart. The graph forces a writable `HOME` and splits
`MODEL=openai/gpt-5.4-mini` into `init_chat_model(name, model_provider=provider)`.

## Live verification record
Each script below was run by hand against real infrastructure when the capability landed; no gate runs them, so
this is a record of what was demonstrated, not a claim that each still passes today.

| Script (`scripts/live/`) | Demonstrated |
| --- | --- |
| `service-topology-nomad.mjs`, `service-topology-k8s.mjs` | warm front door → endpoint discovery → per-case CDP browser → `POST /runs` → MLflow pull → `dom-contains`/`url-matches` → teardown, on Nomad dev and kind |
| `topology-nomad.mjs`, `topology-k8s.mjs` (+ `topology-stub/`) | `ensureTopology` / `provisionBrowserEnv` / `teardown` against a real Nomad agent and a real kind cluster |
| `topology-deps-k8s.mjs` | `provisionDependencies` deploying Postgres + Redis with services reaching them by Service DNS |
| `pool-isolation-k8s.mjs`, `pool-isolation-nomad.mjs`, `minio-pool-k8s.mjs` | pool isolation: a tenant's own creds are DENIED on another tenant's database / bucket, OK on its own |
| `silo-isolation-nomad.mjs` | silo: distinct dedicated store instances per zone |
| `network-isolation-k8s.mjs` | NetworkPolicy on a Calico kind cluster: cross-tenant pod reach and non-managed namespace → shared store BLOCKED |
| `consul-intentions-nomad.mjs`, `connect-enforce-nomad.mjs` | intention decisions via `/v1/connect/intentions/check`; the Connect data-plane differential was not demonstrated |
| `mlflow-trace-ingest.mjs`, `otel-trace-ingest.mjs`, `trace-mlflow.mjs`, `trace-otel.mjs` | real MLflow 3.x and Jaeger spans pulled and normalized into `llm_call`/`tool_call` events |
| `browseruse-topology-drive.mjs`, `browseruse-topology-k8s.mjs`, `browseruse-topology-nomad.mjs` (+ `Dockerfile.browseruse`, `browseruse_server.py`) | a real `browser-use` agent as a front door: interactive multi-step form, OTLP trace with real token counts, on local docker, kind and Nomad |
| `browseruse-isolation-k8s.mjs`, `browseruse-isolation-np.mjs` | per-tenant namespaces with distinct warm pools; cross-tenant reach BLOCKED under Calico |
| `browseruse-realsite.mjs`, `browseruse-scorecard.mjs`, `browseruse-webvoyager.mjs`, `browseruse-webvoyager-judge.mjs`, `browseruse-webvoyager-ab.mjs`, `unified-report.mjs` | real-site runs, scorecard A/B via `diffScorecards`, WebVoyager answer-match and judge grading |

The same period verified capabilities that are not topology-specific; their reference pages are
[datasets.md](datasets.md), [judges.md](judges.md), [command-harness.md](command-harness.md) and
[execution-backends.md](execution-backends.md):
- **Benchmark import** (`@everdict/datasets`): `BENCHMARK_CATALOG` adapters (`mind2web`, `gsm8k`, `gaia`, `webvoyager`,
  `tau-bench`, `browsecomp`, `webarena`, `swe-bench-lite`, `swe-bench-verified`, `osworld`, plus the travel set),
  `fetchHfRows`, `importWebVoyager`/`importJsonl`, tenant recipes as `BenchmarkAdapterSpec` in a
  `BenchmarkRegistry` (`/benchmark-recipes`) — `hf-benchmark-eval.mjs`, `tenant-benchmark-registry.mjs`,
  `webvoyager-eval.mjs`, `webvoyager-diff.mjs`.
- **SWE-bench**: `SweBenchGrader` (gold `test_patch` + `FAIL_TO_PASS`/`PASS_TO_PASS`), `sweBenchImage` prebuilt images as
  `EvalCase.image`, the in-image repo (`repoPath: "/testbed"`), `DockerDriver` as the case compute —
  `swe-bench-grade.mjs`, `swe-bench-image-seed.mjs`, `swe-bench-env-container.mjs`, `swe-bench-in-image.mjs`,
  `swe-bench-real-instance.mjs`; a user-defined test benchmark through `CommandGrader` — `user-benchmark-selfserve.mjs`.
- **Environments**: `PromptEnvironment` (`prompt-env-qa.mjs`) and `OsUseEnvironment` driving real desktop apps with
  `xdotool` and a VLM judge over the screenshot (`JudgeGrader` `useScreenshot`) —
  [`os-use-desktop.mjs`](https://github.com/everdict/everdict/blob/32879892f/scripts/live/os-use-desktop.mjs),
  `os-use-hermes-drive.mjs`, `os-use-hermes-ssh-task.mjs`, `os-use-vlm-judge.mjs`, `os-use-dispatch.mjs`; the OSWorld
  adapter grades with the judge plus a `state-check` grader from each row's `verify` command
  (`examples/benchmarks/osworld-sample.jsonl`).
- **Judge configuration**: `judgeFromEnv` / `makeGradersFromEnv`, `CaseJob.judge` → `judgeEnv`, the workspace default
  (`WorkspaceSettings.judge`) and per-job key resolution (`JudgeAuthDispatcher`) — `judge-dispatch-e2e.mjs`,
  `judge-config-injection.mjs`,
  [`workspace-judge-default.mjs`](https://github.com/everdict/everdict/blob/32879892f/scripts/live/workspace-judge-default.mjs),
  [`judge-grading.mjs`](https://github.com/everdict/everdict/blob/32879892f/scripts/live/judge-grading.mjs).
