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
- `buildNomadTopologyJob(spec)` → Nomad **service** job (task groups, docker + `runsc`, Consul discovery)
- `buildK8sManifests(spec)` → Deployments/Services (+ `runtimeClassName` gVisor)
Register one `ServiceTopologyBackend` per target cluster in the `BackendRegistry`; Router/orchestrator unchanged.

## Trace (`@assay/trace`)
The harness emits a trace to OTel/MLflow; Assay **pulls** it: `OtelTraceSource` / `MlflowTraceSource` →
`spansToTraceEvents` → normalized `TraceEvent[]` (OTel GenAI semantic conventions).

## Grading (browser/service)
Over `{trace, snapshot}` (no `ComputeHandle`): trace-based (`steps`/`cost`/`latency`), browser-outcome
(`dom-contains`, `url-matches` — read the `BrowserSnapshot`), and model judge (`JudgeGrader` — LLM/VLM over
task + DOM/screenshot, via an injected `Judge`). Cases pick graders via `EvalCase.graders` (resolved by
`makeGraders`); judge graders are wired where a `Judge` is configured.

## Status
- **Phase 1 (built, unit-tested):** `HarnessSpec(service)`, OTel/MLflow trace mappers, **both** topology
  builders (Nomad + K8s), env-manager runId keying, orchestrator-agnostic `ServiceTopologyBackend` (mock runtime).
- **Phase 2 (needs infra):** live `NomadTopologyRuntime`/`K8sTopologyRuntime` apply, real browser+extension
  provisioning (headful + xvfb), real OTel/MLflow ingestion, the harness images + extension in a registry.
