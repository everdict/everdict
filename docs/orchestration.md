# Orchestration (durable control plane)

Above routing, the control plane can run each case as a **durable Temporal workflow** so runs
survive control-plane restarts and retry transient backend failures.

## Two orchestrators (`@assay/orchestrator`)
- `DirectOrchestrator(router)` — runs in-process via the Router. Simple; dies with the process.
- `TemporalOrchestrator({address, taskQueue})` — client: starts a workflow and awaits its result.

## Topology (model B + Temporal)
```
assay run --orchestrator temporal  (client)  ── start workflow ──▶ Temporal Server
                                                                        │  task queue
assay worker  (long-running)  ◀── poll ─────────────────────────────────┘
   holds Router(registry) → activity dispatchCase(job) = Router.dispatch → Backend → agent → CaseResult
```
- **Workflow** (`evalCaseWorkflow` / `suiteWorkflow`) is deterministic — it only calls the
  `dispatchCase` **activity** (retry + 1h start-to-close timeout). No I/O in the workflow.
- **Activity** `dispatchCase` does the real backend dispatch (Router → Nomad/K8s/…).
- The **worker** holds the BackendRegistry; the **client** (CLI) just starts + awaits.

## Run it (self-hosted dev)
```bash
# 1) Temporal dev server (gRPC 7233, UI http://localhost:8233)
docker compose -f deploy/temporal/docker-compose.yaml up -d

# 2) worker — holds the backends (here: default single local backend)
pnpm assay worker --temporal-address localhost:7233
#   multi-cluster: pnpm assay worker --backends-config backends.config.json

# 3) client — durable run (blocks until the workflow completes)
pnpm assay run --orchestrator temporal --task "..." --test "..."
```
Jobs route by `placement.target` (set via `--target`); suites fan out via `suiteWorkflow`.

> Default `--orchestrator direct` keeps the in-process path (no Temporal needed).
> Production: use a persistent Temporal deployment (auto-setup + Postgres/Cassandra).
