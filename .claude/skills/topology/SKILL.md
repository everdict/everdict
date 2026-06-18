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

## Reference impls
`packages/topology/src/{nomad-topology,nomad-runtime,k8s-topology,service-backend,environment-manager}.ts`,
`packages/trace/src/{otel,mlflow,trace-source}.ts`. Live now: NomadTopologyRuntime apply + per-case CDP browser
(see `scripts/live/service-topology-nomad.mjs`). Still Phase 2: K8sTopologyRuntime apply, real browser+extension
(headful+xvfb+`--load-extension`) & browser-use images, real OTel/MLflow span ingestion.
