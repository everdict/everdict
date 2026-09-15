---
kind: wiki
title: "Orchestration (durable control plane)"
status: current
updated: 2026-09-15
anchors: [packages/orchestrator/src/workflows.ts, packages/orchestrator/src/orchestrator.ts, packages/orchestrator/src/worker.ts, apps/api/src/core/ops/driver-ops-service.ts, apps/api/src/core/scorecard/temporal-batch-driver.ts]
---
# Orchestration (durable control plane)

> **Role charter vs the event plane:** see
> [architecture/event-plumbing.md](architecture/event-plumbing.md) — one line separates the two
> ("does the work have a definition of done?"): Temporal owns completion-bearing plans (batch driver,
> schedule clock) and stays optional (Direct fallback); the event plane owns open-ended perception and
> reaction. Temporal fires facts and executes plans; it never routes facts or decides reactions.

Above routing, the control plane can run work as **durable Temporal workflows** so it survives
control-plane restarts and retries transient failures.

## Why a workflow engine at all — the DIY ladder

What Temporal sells is not "workflows"; it is **a durable program counter**. In an ordinary program,
"where was I" — the loop index, retry counts, partial results, what comes next — lives in RAM and dies
with the process. The work itself may survive (cases keep running on runtimes); *knowing where you were*
does not. The boot recovery says so verbatim (`runStartupRecovery`): *"batches/runs are tracked
in-process … at restart any queued/running record is a ghost with no one to resume it."*

**The ladder you climb without an engine:**

- **Rung 0 — in-process loop** (`DirectOrchestrator`): restart = ghosts. Fine for dev.
- **Rung 1 — checkpoint in the DB + a recovery sweep** (what boot recovery does: the run ledger as
  checkpoint, `recoverInterrupted`, adoption-then-`caseSpec`-re-dispatch (migration 0051 exists *for this*),
  tombstones, background adoption so a long run doesn't block startup). The tax: **the recovery path is a
  second implementation of the forward path** and must agree with it forever — every feature (trials,
  spillover, retry classes, streaming phases) lands twice. And four things are still missing: durable
  **timers** ("retry in 90s", "wait 3 days" ⇒ `next_*_at` columns + a poller = a scheduler reinvented in a
  table), **HA safety** (two replicas both sweep ⇒ hand-rolled leases), **in-flight versioning** (deploy
  during a 2-hour batch: the checkpoint says plan A, the new code is plan B), and **signal delivery** (cancel
  must find the right process mid-`await`).
- **Rung 2 — generalize it** for the second and third durable process (approval waits, reapers,
  retention): process table + step executor + retry policies + timer poller + leases + idempotency +
  versioning + a debug surface… **you have written a workflow engine**, minus the history/replay
  debugging, the query language, the batch operations, and the gRPC surface the ops agent needs.

**What the engine mechanically provides:** deterministic replay (any worker rebuilds RAM — locals and
program counter — from the event history and continues at the next line; the forward path IS the recovery
path, one implementation), server-owned durable timers (`sleep(72h)` fires even if every worker was
down), declarative per-activity retry policies, `workflowId` dedup, durable signal delivery, task-queue
HA without leases, patch APIs for in-flight versioning — and the history that powers the Driver ops
surface.

**What it does NOT remove:** effect idempotency stays ours. If a worker dies mid-activity the activity
retries — `dispatchCase` must not double-dispatch, which is why the adoption/zero-re-run discipline remains
valuable *with* Temporal. The engine erases "where was I" (control state), never "is it safe to do twice"
(effects). And for **open-ended convergence** (autoscaler, event consumers, anything level-triggered), a
reconciliation loop over desired state is the *better* tool — the charter's line holds from the other side.

**Break-even:** one durable process with short steps → rung 1 is a defensible price. Days-long waits,
per-step retry policies, HA replicas, deploys during long runs, and above all a *growing count of distinct
durable processes* → the per-process tax exceeds the cost of the engine. `runStartupRecovery` remains only
for what workflows don't own; every adoption below moves state into a workflow that recovers itself.

## Workflows running today (`@everdict/orchestrator` `workflows.ts`)

Every candidate passed the charter filter (**definition of done + must survive crashes/time + not
open-ended**). The T-a…T-d labels are the ones code comments cite.

| Workflow | workflowId | Started by | Done when |
|----------|------------|------------|-----------|
| `evalCaseWorkflow` | `everdict-<caseId>-<pid>` | `TemporalOrchestrator` (CLI `--orchestrator temporal`) | its one `dispatchCase` activity returns |
| `scorecardBatchWorkflow` | `everdict-batch-<scorecardId>` | `TemporalBatchDriver.start` | every (case, trial) ran via `runBatchCase`, then `finalizeBatch` |
| `scoreGroupWorkflow` (T-c) | `everdict-score-<groupId>-<passId>` | `TemporalBatchDriver.startScore` | the replanned worklist is empty, or the stall guard abandons |
| `approvalWorkflow` (T-a) | `everdict-approval-<approvalId>` | `TemporalBatchDriver.startApproval` | the `decided` signal, or the timer → `expireApproval` |
| `sessionReaperWorkflow` (T-b) | `everdict-reaper-<runId>` | `TemporalBatchDriver.startReaper` (sandbox create) | the `closed` signal, or the deadline → `reapSession` |
| `reactionWorkflow` (T-d) | `everdict-reaction-<eventId>-<subscriptionId>` | the `subscriptions:reactions` cursor consumer | every step completed, or the first step skipped/failed/timed out |
| `scheduledScorecardWorkflow` | `everdict-sched-run-<scheduleId>` (+ fire time) | a Temporal Schedule `everdict-sched-<scheduleId>` (`TemporalScheduleDriver`) | the fired scorecard is terminal → finalize, or the ~4 h poll cap |

Every workflow except `evalCaseWorkflow` drives the control plane over the internal HTTP
bridge (`/internal/batches/**`, `/internal/groups/**`, `/internal/approvals/**`, `/internal/sandboxes/:id/reap`,
`/internal/reactions/**`, `/internal/schedules/**`), enabled on the worker by `EVERDICT_API_URL` +
`EVERDICT_INTERNAL_TOKEN`. The workflow owns durability; the control plane owns the semantics.

- **Batch** — continue-as-new every 500 cases or on history pressure (`continueAsNewSuggested` or 20,000
  events); `planBatch` is unfinished-only, so a continuation picks up exactly the remainder.
- **Score pass (T-c)** — the detached phase-2 pass, pass-scoped: the database marker's compare-and-swap is
  the sole authority on who owns a group, and every activity presents its `passId` so a superseded pass is
  fenced. `prepareScore` strips once per pass (the `prepared` flag rides continue-as-new); `planScore`
  (unfinished-only) + `scoreGroupCase` (skip-if-judged) give restart-safe, zero-duplicate re-scoring. The loop
  is PLAN → EXECUTE → REPLAN: it finishes when a fresh plan is empty. Termination is the pure
  `decideScoreRound`; the stall guard (`MAX_STALLED_SCORE_ROUNDS`) and the logical round ordinal both ride
  continue-as-new, so rotating neither resets a stuck pass nor lets a round's first attempt lose to the
  previous round's. Giving up is recorded (`finalizeScore` with `abandoned`), and a failed workflow reports
  its own death (`failScore`). Only runIds-backed groups route here; an embed group, or a start failure other
  than a conflict, takes the in-process pass.
- **Approval (T-a)** — only the WAIT is durable; the agent loop stays in `apps/agent`, which resumes a
  decided run as one continuation turn from its transcript. Expiry is idempotent against a settled record.
- **Reaper (T-b)** — `extend` re-arms the deadline without the workflow reading a clock. The reap activity
  retries without limit (capped backoff), because a control-plane outage is the case it exists for. A handle
  lost to a control-plane death settles the row `orphaned` and removes the container by the row's compute id
  (`Driver.reap`). **The ledger orphan sweep is the safety net under it**: `sweepOrphans` (boot + interval,
  leader-gated, sandbox and browser lanes) settles any `running` session row past its deadline + grace that
  no live process holds — so a reaper that never armed (`startReaper` is best-effort) cannot leave a zombie.
  Boot recovery leaves session runs alone (not resumable work).
- **Reaction (T-d)** — started for `reaction.kind="workflow"` subscriptions; the id includes the rule, so two
  subscriptions on one fact chain independently while redelivery collapses. Each step is one agent
  activation watched under a per-step budget (default 2 h; `awaiting_approval` counts as alive). The workflow
  adds no judgment — the runs narrate on the event log.

## Not workflows

**Candidates, not built:** cascade-cancel walker (O8 — today's cascade revokes caused scorecard batches
in-process via `cancelCausedBy`) · pull-ingest shim pipeline · retention/TTL sweeps on Temporal Schedules (the
event-log and trajectory retention run as in-process hourly sweeps — `EVERDICT_EVENT_RETENTION_DAYS` /
`EVERDICT_TRAJECTORY_RETENTION_DAYS`, unset = keep forever) · CI re-pin · export attach-back durability ·
benchmark/dataset imports.

**Anti-catalog (charter-failed — never workflows):** event routing/fan-out · the agent loop itself (not a
second agent runtime) · autoscaler/scheduler control loops (continuous, no completion) · notification
fan-out (a cursor consumer) · the admission gate · a session's interactive I/O (only its TTL timer).

## Expansion disciplines
- **Deterministic workflow IDs are the correlation grammar** — `everdict-<family>-<ledgerId>`, so idempotency
  and ledger-vocabulary addressing come free. `DriverOpsService.workflowIdFor` / `parseDriverWorkflowId` are
  the forward and inverse directions.
- **Every workflow is in the Driver ops surface** — `GET /ops/driver/:family/:id`, `POST …/cancel`,
  `POST …/terminate` ↔ MCP `describe_driver_workflow` / `cancel_driver_workflow` /
  `terminate_driver_workflow`. Families `batch | score | approval | reaper | reaction`; addressed by ledger id,
  never a raw workflowId, and scoped by the family's own ledger (batch/score → scorecard row, approval →
  approval store, reaper → sandbox run row, reaction → the subscription rule of `<eventId>-<subscriptionId>`).
  Read = `runtimes:read`; cancel/terminate = `runtimes:control`. The `score` family addresses the pass in
  flight by the workflow id its pass marker recorded (`scoringPass.workflowId`, which is
  `everdict-score-<groupId>-<passId>`); a scorecard with no Temporal pass in flight answers 404.
  The OPERATOR plane (`x-internal-token`, deliberately outside workspace scoping because a leaked workflow's
  ledger record is gone by definition) has `GET /internal/driver/workflows` (every `everdict-*` workflow
  across tenants, family/ledger parsed back out of the id) + `POST /internal/driver/workflows/terminate` (raw
  workflowId; refuses non-everdict workflows). Neither writes the ledger — the recovery sweeps settle whatever
  row a dead workflow owned.
- **The schedule clock self-heals** — a fire whose record is gone deletes the orphan Temporal schedule at the
  fire choke point, `TemporalScheduleDriver.remove` surfaces real failures (the DB row survives a failed
  driver delete), and boot runs `ScheduleService.reconcile()` (Temporal ⟶ DB; the DB is SSOT).
- **Workflows never emit facts directly** — their activities' state transitions do (same-tx outbox), so
  the event plane's "transition ⇒ fact" invariant holds inside workflows too.
- **Activities that create demand pass the admission gate** — a workflow is not a side door around it.

## Two orchestrators (`@everdict/orchestrator`)
- `DirectOrchestrator(dispatcher)` — runs in-process via a `Dispatcher` (Router or Scheduler). Simple; dies with the process.
- `TemporalOrchestrator({address, taskQueue})` — client: starts an `evalCaseWorkflow` and awaits its result.

## Topology (dispatched worker + Temporal)
```
everdict run --orchestrator temporal  (client)  ── start workflow ──▶ Temporal Server
                                                                        │  task queue everdict-eval
everdict worker  (long-running)  ◀── poll ──────────────────────────────┘
   holds Scheduler(registry) → activity dispatchCase(job) = Scheduler.dispatch → Backend → agent → CaseResult
```
- **Workflow code is deterministic** — no I/O; `evalCaseWorkflow` only calls the `dispatchCase` **activity**
  (1 h start-to-close, 1 min heartbeat timeout, 3 attempts).
- **Activity** `dispatchCase` does the real backend dispatch through the worker's capacity-aware
  **`Scheduler`** (gates on `Backend.capacity()`, queues when full) — see `docs/execution-backends.md`.
- The **worker** (`runWorker`) holds the BackendRegistry + Scheduler; the **client** (CLI) just starts + awaits.

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
Jobs route by `placement.target` (set via `--target`). `everdict suite --orchestrator temporal` starts one
`evalCaseWorkflow` per case, with client-side concurrency (`--concurrency`).

> Default `--orchestrator direct` keeps the in-process path (no Temporal needed).
> Production: use a persistent Temporal deployment (auto-setup + Postgres/Cassandra).
