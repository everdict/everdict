# Orchestration (durable control plane)

> **Role charter vs the event plane:** see
> [architecture/event-plumbing.md](architecture/event-plumbing.md) — one line separates the two
> ("does the work have a definition of done?"): Temporal owns completion-bearing plans (batch driver,
> schedule clock) and stays optional (Direct fallback); the event plane owns open-ended perception and
> reaction. Temporal fires facts and executes plans; it never routes facts or decides reactions.

Above routing, the control plane can run each case as a **durable Temporal workflow** so runs
survive control-plane restarts and retry transient backend failures.

## Why a workflow engine at all — the DIY ladder

What Temporal sells is not "workflows"; it is **a durable program counter**. In an ordinary program,
"where was I" — the loop index, retry counts, partial results, what comes next — lives in RAM and dies
with the process. The work itself may survive (cases keep running on runtimes); *knowing where you were*
does not. Our own code states the problem verbatim (`runStartupRecovery`): *"batches/runs are tracked
in-process … at restart any queued/running record is a ghost with no one to resume it."*

**The ladder you climb without an engine** (we are standing on rung 1):

- **Rung 0 — in-process loop** (`DirectOrchestrator`): restart = ghosts. Fine for dev.
- **Rung 1 — checkpoint in the DB + a recovery sweep** (what we built: the run ledger as checkpoint,
  `recoverInterrupted`, adoption-then-`caseSpec`-re-dispatch (mig 0051 exists *for this*), tombstones,
  background adoption so a long run doesn't block startup). The tax: **the recovery path is a second
  implementation of the forward path** and must agree with it forever — every feature (trials, spillover,
  retry classes, streaming phases) lands twice. And four things are still missing: durable **timers**
  ("retry in 90s", "wait 3 days" ⇒ `next_*_at` columns + a poller = a scheduler reinvented in a table),
  **HA safety** (two replicas both sweep ⇒ hand-rolled leases), **in-flight versioning** (deploy during a
  2-hour batch: the checkpoint says plan A, the new code is plan B), and **signal delivery** (cancel must
  find the right process mid-`await`).
- **Rung 2 — generalize it** for the second and third durable process (approval waits, reapers,
  retention): process table + step executor + retry policies + timer poller + leases + idempotency +
  versioning + a debug surface… **you have written a workflow engine**, minus the history/replay
  debugging, the query language, the batch operations, and the gRPC surface the ops agent needs (044).

**What the engine mechanically provides:** deterministic replay (any worker rebuilds RAM — locals and
program counter — from the event history and continues at the next line; the forward path IS the recovery
path, one implementation), server-owned durable timers (`sleep(72h)` fires even if every worker was
down), declarative per-activity retry policies, `workflowId` dedup, durable signal delivery, task-queue
HA without leases, patch APIs for in-flight versioning — and the history that powers the Driver ops
surface for free.

**What it does NOT remove (honesty):** effect idempotency stays ours. If a worker dies mid-activity the
activity retries — `dispatchCase` must not double-dispatch, which is exactly why the adoption/zero-re-run
discipline remains valuable *with* Temporal. The engine erases "where was I" (control state), never
"is it safe to do twice" (effects). And for **open-ended convergence** (autoscaler, event consumers,
anything level-triggered), a reconciliation loop over desired state is the *better* tool — the charter's
line holds from the other side.

**Break-even, stated plainly:** one durable process with short steps → rung 1 is a defensible price (we
paid it). Days-long waits, per-step retry policies, HA replicas, deploys during long runs, and — above
all — a *growing count of distinct durable processes* (Tier 1 alone adds four) → the per-process tax
exceeds the cost of the engine. Keeping Temporal is the decision to stop paying that tax per process;
the size of `runStartupRecovery` is the running meter of what rung 1 costs.

## Workflow catalog — charter-filtered expansion (DESIGN)

The ops-agent audit ([event-plumbing.md](architecture/event-plumbing.md), The ops-agent test) settled
that Temporal stays — which raises the follow-up: use it *better*. Every candidate below passed the
charter filter (**definition of done + must survive crashes/time + not open-ended**); everything that
failed is listed in the anti-catalog so it cannot creep in later.

**Running today (5):** `evalCaseWorkflow` · `suiteWorkflow` · `scorecardBatchWorkflow` (+ the
workflow-owned retry batch) · `scheduledScorecardWorkflow` + `TemporalScheduleDriver` (the clock) ·
`scoreGroupWorkflow` (`everdict-score-<groupId>` — Tier-1 item 3, SHIPPED in W2: the detached phase-2
pass; planScore's unfinished-only idempotence + scoreGroupCase's skip-if-judged give restart-safe,
zero-duplicate re-scoring; start failure degrades to the in-process pass).

**Tier 1 — adopt next (each unlocks a roadmap phase):**

1. **Durable parked approvals** — `approvalWorkflow(approvalId)`: park → notify (activity) → durable
   wait for the decision signal or a days-long timer → resume/deny. Done = approved | denied | expired.
   Replaces the in-process park (10-min deny-on-expiry; an agent-service restart expires as deny —
   agent-automation's recorded v1 bound). *Unlocks:* A6's full shape; `default` permission mode becomes
   usable for headless automation. The agent loop stays in `apps/agent` — the workflow owns only the WAIT.
2. **Session/warm reapers as durable per-entity timers** — `reaperWorkflow(runId)`: `sleep(ttl)` +
   extend/close signals → teardown activity. Done = torn down. *Unlocks:* execution-model P6 ("the reaper
   is the `finally`" made crash-proof for sandbox runs); browser sessions fold in later (O6); warm-pool
   idle teardown is the same pattern.
3. **Phase-2 scoring** — `scoreWorkflow(groupId, spec)`: judge N×M with per-case retries → aggregate →
   persist. Done = scored + aggregated. *Unlocks:* execution-model P2 — re-scoring a 500-case group
   survives restarts instead of dying with the process. **SHIPPED (W2)** as `scoreGroupWorkflow` — see
   "Running today" above; only runIds-backed groups route to it (an embed group has no per-case store for
   idempotent write-back, so it takes the in-process pass).
4. **Heavy event reactions (the E3 executor)** — a thin consumer starts `workflowId = eventId`
   (idempotent by construction); the workflow runs the multi-step reaction. First residents: regression
   triage, the scorecard-fix-PR chain.

**Tier 2 — adopt opportunistically:** cascade-cancel walker (O8: done = every non-terminal descendant
cancelled; big trees need retries against runtimes) · pull-ingest shim pipeline (pull → materialize →
judge → attach-back; the demoted-but-alive import path) · retention/TTL sweeps on Temporal Schedules
(event-log TTL, trajectory retention N3, image-store GC) · CI re-pin (merge → digest resolution →
new immutable version; small but flaky-prone).

**Tier 3 — hold:** export attach-back durability (the charter *allows* a mirror to be lossy — only if
attach failures become a real burden) · benchmark/dataset imports (one-shot; only if size demands).
**Boot recovery should SHRINK, not grow:** every Tier-1/2 adoption moves state into workflows that
recover themselves; `runStartupRecovery` remains only for what workflows don't own.

**Anti-catalog (charter-failed — never workflows):** event routing/fan-out (rule 1) · the agent loop
itself (not a second agent runtime) · autoscaler/scheduler control loops (continuous, no completion) ·
notification fan-out (a cursor consumer) · the admission gate · a session's interactive I/O (only its
TTL timer).

**Expansion disciplines** (what keeps "more Temporal" safe):
- **Deterministic workflow IDs are the correlation grammar** — `workflowIdFor(scorecardId)` exists;
  extend the family (`approval:<id>`, `reaper:<runId>`, `score:<groupId>`, `reaction:<eventId>`) so
  idempotency and ledger-vocabulary addressing come free.
- **Every new workflow lands in the Driver ops surface on day one** — describe/pending/cancel visible to
  the ops agent; a workflow the agent can't see violates the adoption gate that justified Temporal.
- **Workflows never emit facts directly** — their activities' state transitions do (same-tx outbox), so
  the event plane's "transition ⇒ fact" invariant holds inside workflows too.
- **Activities that create demand pass the §5 gate** — a workflow is not a side door around admission.

## Two orchestrators (`@everdict/orchestrator`)
- `DirectOrchestrator(dispatcher)` — runs in-process via a `Dispatcher` (Router or Scheduler). Simple; dies with the process.
- `TemporalOrchestrator({address, taskQueue})` — client: starts a workflow and awaits its result.

## Topology (dispatched worker + Temporal)
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
