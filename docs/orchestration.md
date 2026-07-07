# Orchestration (durable control plane)

Above routing, the control plane can run each case as a **durable Temporal workflow** so runs
survive control-plane restarts and retry transient backend failures.

## Two orchestrators (`@everdict/orchestrator`)
- `DirectOrchestrator(dispatcher)` — runs in-process via a `Dispatcher` (Router or Scheduler). Simple; dies with the process.
- `TemporalOrchestrator({address, taskQueue})` — client: starts a workflow and awaits its result.

## Topology (model B + Temporal)
```
everdict run --orchestrator temporal  (client)  ── start workflow ──▶ Temporal Server
                                                                        │  task queue
everdict worker  (long-running)  ◀── poll ─────────────────────────────────┘
   holds Scheduler(registry) → activity dispatchCase(job) = Scheduler.dispatch → Backend → agent → CaseResult
```
- **Workflow** (`evalCaseWorkflow` / `suiteWorkflow`) is deterministic — it only calls the
  `dispatchCase` **activity** (retry + 1h start-to-close timeout). No I/O in the workflow.
  `suiteWorkflow` uses a **bounded** lane count so a big suite can't flood activity slots.
- **Activity** `dispatchCase` does the real backend dispatch via a `Dispatcher`. The worker wires a
  capacity-aware **`Scheduler`** (gates on `Backend.capacity()`, queues when full) — see
  `docs/execution-backends.md`.
- The **worker** holds the BackendRegistry + Scheduler; the **client** (CLI) just starts + awaits.

## Run it (self-hosted dev)
```bash
# 1) Temporal dev server (gRPC 7233, UI http://localhost:8233)
docker compose -f deploy/temporal/docker-compose.yaml up -d

# 2) worker — holds the backends (here: default single local backend)
pnpm everdict worker --temporal-address localhost:7233
#   multi-cluster: pnpm everdict worker --backends-config backends.config.json

# 3) client — durable run (blocks until the workflow completes)
pnpm everdict run --orchestrator temporal --task "..." --test "..."
```
Jobs route by `placement.target` (set via `--target`); suites fan out via `suiteWorkflow`.

> Default `--orchestrator direct` keeps the in-process path (no Temporal needed).
> Production: use a persistent Temporal deployment (auto-setup + Postgres/Cassandra).
