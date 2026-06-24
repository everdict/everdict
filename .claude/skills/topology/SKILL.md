---
name: topology
description: Service-topology harnesses (multi-service + browser/OS target env) — HarnessSpec(service), warm-pool/shared-store/per-case efficiency, orchestrator-agnostic deploy (Nomad + K8s), OTel/MLflow trace ingestion. Use when implementing service harnesses, a TopologyRuntime, or trace pulling.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Service-topology harnesses

A harness can be a process (Claude Code) or a **deployed multi-service topology that acts on a target env**
(browser/OS). See `docs/service-harness.md`.

## The model
- `HarnessSpec(kind:"service")`: `services[]` + `dependencies[]` (shared stores) + `target` (browser+ext) +
  `frontDoor` + `traceSource`.
- A run = ensure warm topology → per-case browser → drive (front-door `POST /runs` with per-run wiring) →
  collect trace (OTel/MLflow) → observe (browser snapshot) → grade.

## Efficiency (the whole point)
stateless services = per-version warm; stores = shared + per-case logical isolation
(`thread_id`/key-prefix/object-prefix); browser = per-case. Wiring via the front-door, not a redeploy.

## Orchestrator-agnostic
`ServiceTopologyBackend` (a `Backend`) holds a `TopologyRuntime`. Only the runtime differs:
`buildNomadTopologyJob` (Nomad) vs `buildK8sManifests` (K8s). Both pure + deterministic-tested.

## Live Nomad runtime
`NomadTopologyRuntime` implements `TopologyRuntime` against the Nomad API: `ensureTopology` registers the
warm service job, polls each group to running, and discovers endpoints from the alloc via pure `resolvePort`
(`AllocatedResources.Shared.Ports` → `Resources.Networks`); `provisionBrowserEnv` runs a per-case headless
Chromium and discovers its CDP from `/json/version`. Services with a `port` get a group dynamic-port (no Consul).
**Tenant isolation:** `ensureTopology`/`provisionBrowserEnv` take an optional `TrustZone`; the warm pool is keyed
by `(spec, version, zone.id)` and the job ID/namespace carry the zone — warm topologies are **never shared across
tenants** (a shared agent/LangGraph process would leak state/secrets). Verified live on Nomad.

## Live K8s runtime
`K8sTopologyRuntime` is the same shape via an injectable `Kubectl` (default shells to `kubectl`):
`ensureNamespace` (per-tenant namespace = isolation) → `apply` Deployment+Service → `rollout status` → endpoint
via `kubectl port-forward svc/… :<port>` (parse the local port from stdout). `provisionBrowserEnv` runs a
headless-Chromium Deployment+Service; `dispose()` deletes only the browser (warm topology survives), `teardown()`
deletes the namespace. `imagePullPolicy`/`runtimeClass` are options (kind: pre-`kind load` images + IfNotPresent).
Verified live on kind — Nomad↔K8s parity.

## Front-door generalization — making driving harness-agnostic (in progress)
`ServiceTopologyBackend.dispatch` was hardcoded to one protocol (browser-use-langgraph): fixed payload,
fire-and-forget submit, trace-by-Assay-runId, always-provisioned browser, fixed image. The direction — a declarative
`FrontDoorProtocol` + a thin `FrontDoorDriver` (the harness-agnostic sibling of `TopologyRuntime`), each hardcode →
an optional knob defaulting to today — is in `docs/architecture/front-door-generalization.md`. Read it before
touching `service-backend.ts`'s driving logic.
- **#2 completion — DONE.** `FrontDoorDriver`/`HttpFrontDoorDriver` (`front-door-driver.ts`) own submit + await;
  `frontDoor.completion` (`sync` default | `poll` with a `StatusMatch` done/failed matcher) in `@assay/core`;
  dispatch fails a run on completion timeout. `poll` = "hold until an async N-step agent finishes."
- **#3 correlate — DONE.** `frontDoor.correlate` (`injected` default = Assay runId | `returned` = extract the
  agent's own id from the submit response via `correlate.path` dot-path, used for both trace fetch and the poll
  `statusPath`). `SubmitFn` now returns the response body. Distinct from the still-dormant `frontDoor.trace` endpoint.
- **#1 payload template — DONE.** `frontDoor.request.bodyTemplate` (`interpolateTemplate` — recursive `{{var}}`
  over the JSON body); per-run wiring variable NAMES derive from `dependencies[].isolateBy` via `wiringVars`
  (`thread_id`/`key_prefix`/`object_prefix`/`schema`), not hardcoded LangGraph names. Absent `request` = today's body.
- **#4 target observation — DONE (none/assay).** Browser provisioning is gated on `spec.target` (already optional,
  was ignored): absent → no browser, trace-only run with a `{kind:"prompt"}` snapshot (no core-contract change).
  `harness`-provided target (observe a declared service's CDP) needs a `TopologyRuntime.observe` method — follow-up.
- **#5 per-service image pin — DONE.** `AgentJob.imagePins` (service name → image) overrides registered images at
  dispatch; `applyImagePins` (`image-pins.ts`) folds pins into a deterministic `-pin-<hash>` effective version so
  warm pools (id@version-keyed) separate variants with no runtime change; unknown service → `BadRequestError`.
- **All 5 core knobs landed.** Follow-ups: completion `stream`/`callback`, `harness`-provided target observation,
  a `request.headers` knob — see `docs/architecture/front-door-generalization.md`.

## Observation delivery (`HOW-observe`) — pluggable seam
*How* the observation reaches the grader/judge is now a third axis (sibling of `TopologyRuntime`=WHERE,
`FrontDoorDriver`=HOW-drive): `ObservationSource` (`observation-source.ts`). `TopologyTarget.delivery`
(`@assay/core`, `.optional()`) selects `reference` (store-fetch, default = today's `snapshot()`/prompt) |
`sentinel` (inline via result channel) | `egress` (push to a `sink`). `dispatch` delegates to
`observationSourceFor(spec.target?.delivery)`; **unimplemented modes throw explicitly** (no silent fallback).
`reference` + `sentinel` are wired; `egress` is a later slice. **`sentinel`** reads the observation from the
**result channel** (`DriveOutcome.response` — `sync` = submit response, `poll` = the `done` status body) via
`delivery.path?` (dot-path, `getField`) and validates it as an `EnvSnapshot`. Pairs with judge store-locality
(co-locate the judge near the store) — `docs/architecture/judge-placement-locality.md`.

## Reference impls
`packages/topology/src/{nomad-topology,nomad-runtime,k8s-topology,k8s-runtime,kubectl,service-backend,environment-manager}.ts`,
`packages/trace/src/{otel,mlflow,trace-source}.ts`. Live now: both NomadTopologyRuntime + K8sTopologyRuntime apply
+ per-case CDP browser (`scripts/live/service-topology-{nomad,k8s}.mjs`). Still Phase 2: real browser+extension
(headful+xvfb+`--load-extension`) & browser-use images, real OTel/MLflow span ingestion.
