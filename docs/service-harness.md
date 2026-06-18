# Service-topology harnesses

A harness can be a single process (Claude Code) OR a **multi-service topology that acts on a target
environment** (browser/OS). Example: **browser-use-langgraph** = {agent-server (LangGraph; front-door),
browser-mcp, action-stream} + {Postgres checkpoints, Redis stream, MinIO snapshots} + a per-case headful
Chromium loading a client browser extension (the extension drives the browser).

## Spec (`HarnessSpec`, kind: "service")
`services[]` (per-version warm) · `dependencies[]` (shared store + `isolateBy`) · `target`
(browser+extension, per-case) · `frontDoor` ({service, submit, trace}) · `traceSource` ({kind: otel|mlflow, endpoint}).

## Efficiency (orchestrator-agnostic)
- stateless services → **per-version warm pool**
- Postgres/Redis/MinIO → **shared**, isolated per case by `thread_id` / key-prefix / object-prefix
- browser(+extension) → **per-case** fresh instance (headful + xvfb) — the only per-case unit
- per-run wiring (`thread_id` / `stream_channel` / `minio_prefix` / `browser_cdp_url`) is injected via the
  front-door `POST /runs` to the **warm** agent — not a redeploy.

## Orchestrator-agnostic (Nomad AND K8s)
`ServiceTopologyBackend` (a `Backend`) is orchestrator-agnostic; only `TopologyRuntime` differs:
- `buildNomadTopologyJob(spec)` → Nomad **service** job (task groups, docker + `runsc`, dynamic ports)
- `buildK8sManifests(spec)` → Deployments/Services (+ `runtimeClassName` gVisor)
Register one `ServiceTopologyBackend` per target cluster in the `BackendRegistry`; Router/orchestrator unchanged.

### `NomadTopologyRuntime` (live)
The live Nomad runtime (`@assay/topology`) implements `TopologyRuntime` against the Nomad HTTP API:
- `ensureTopology(spec)` → register the warm **service** job, poll each group's alloc to `running`, and
  **discover endpoints** from the alloc (`resolvePort` reads `AllocatedResources.Shared.Ports`, falling back
  to `Resources.Networks`); cache per `id@version` so a version deploys once.
- `provisionBrowserEnv(spec, runId)` → register a per-case browser **service** job (headless Chromium), discover
  its CDP port, return a `BrowserEnvHandle` whose `cdpUrl` comes from `/json/version` and whose `snapshot()`
  reads `/json/list`. Registration failures are cleaned up (no leaked allocs); `dispose()`/`teardown()` purge.
- Services declare a `port` → the builder attaches a group `network` dynamic port (label `http`, browser `cdp`)
  and maps it into the container, so endpoints are reachable from the control plane without Consul.

### `K8sTopologyRuntime` (live)
The live K8s runtime is the same shape against the Kubernetes API (via an injectable `Kubectl`, default shells
to `kubectl`):
- `ensureTopology(spec, zone)` → `ensureNamespace` (per-tenant **namespace** = the isolation boundary) →
  `apply` `buildK8sManifests` (Deployment + Service per service) → `kubectl rollout status` →
  **discover endpoints** via `kubectl port-forward svc/… :<port>` (kubectl picks the local port; the runtime
  parses it from stdout). Cached per `(id, version, zone)`.
- `provisionBrowserEnv(spec, runId, zone)` → `buildBrowserManifests` (headless-Chromium Deployment + Service) →
  rollout → port-forward CDP → `BrowserEnvHandle`. `dispose()` deletes **only** the browser Deployment/Service
  (the warm topology in the same namespace survives); `teardown()` deletes the namespace.
- Tenant isolation is K8s-native: each zone is its own namespace, so two tenants on the same harness version get
  separate Deployments. `runtimeClass` (gVisor) and `imagePullPolicy` are runtime options.

## Trace (`@assay/trace`)
The harness emits a trace to OTel/MLflow; Assay **pulls** it: `OtelTraceSource` / `MlflowTraceSource` →
`spansToTraceEvents` → normalized `TraceEvent[]` (OTel GenAI semantic conventions).

## Grading (browser/service)
Over `{trace, snapshot}` (no `ComputeHandle`): trace-based (`steps`/`cost`/`latency`), browser-outcome
(`dom-contains`, `url-matches` — read the `BrowserSnapshot`), and model judge (`JudgeGrader` — LLM/VLM over
task + DOM/screenshot, via an injected `Judge`). Cases pick graders via `EvalCase.graders` (resolved by
`makeGraders`); judge graders are wired where a `Judge` is configured.

## Live validation (Nomad)
`scripts/live/service-topology-nomad.mjs` runs a full service-topology case on a real Nomad cluster:
warm front-door deployed as a Nomad service job → endpoint discovered from the alloc → per-case headless
Chromium provisioned with a real CDP endpoint → real `POST /runs` with per-run wiring (verified by the
front-door's HTTP 200) → trace pulled from real MLflow → `dom-contains`/`url-matches` graded over the real
browser snapshot → both jobs purged on teardown. Confirmed end-to-end (~6s) on Nomad v2.0.3 dev (docker
driver) with stand-ins: front-door = `mendhak/http-https-echo`, browser = `chromedp/headless-shell`.

```bash
NOMAD_ADDR=http://127.0.0.1:4646 MLFLOW_ENDPOINT=http://127.0.0.1:5501 \
  node scripts/live/service-topology-nomad.mjs
```

## Live validation (Kubernetes / kind)
`scripts/live/service-topology-k8s.mjs` runs the same case on a real K8s cluster via `K8sTopologyRuntime`:
namespace-per-tenant (`assay-acme`) → Deployment+Service applied → rollout → endpoint via `port-forward` →
per-case headless-Chromium with a real CDP endpoint → real `POST /runs` (HTTP 200) → MLflow trace → `dom`/`url`
graded over the real browser snapshot → namespace deleted on teardown. Confirmed end-to-end (~3s) on a local
**kind** cluster — proving Nomad↔K8s parity through the orchestrator-agnostic `ServiceTopologyBackend`.

### Local kind cluster (persistent, for experiments)
```bash
# one-time: kubectl + kind to ~/.local/bin, then
kind create cluster --name assay
# load the stand-in images into the kind node (its own containerd; no registry needed)
kind load docker-image mendhak/http-https-echo:latest chromedp/headless-shell:latest --name assay
PATH=$HOME/.local/bin:$PATH node scripts/live/service-topology-k8s.mjs
```
The cluster persists across runs (`kind get clusters`); `kind delete cluster --name assay` to remove. gVisor
(`runtimeClass`) is not installed on kind, so the demo uses the default runtime; namespace isolation is real.

## Status
- **Phase 1 (built, unit-tested):** `HarnessSpec(service)`, OTel/MLflow trace mappers, **both** topology
  builders (Nomad + K8s), env-manager runId keying, orchestrator-agnostic `ServiceTopologyBackend` (mock runtime).
- **Phase 2 — live `NomadTopologyRuntime`: DONE** (real Nomad apply + endpoint discovery + per-case CDP browser
  + drive + MLflow pull + grade + teardown; see above). **Still pending:** `K8sTopologyRuntime` apply, the real
  browser+extension (headful + xvfb + `--load-extension`) and the real browser-use images, real OTel/MLflow
  span ingestion (the stand-in emits no GenAI spans → trace is empty), the harness images + extension registry.
