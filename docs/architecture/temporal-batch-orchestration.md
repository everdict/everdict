---
kind: wiki
title: "Temporal batch orchestration — a scorecard batch as one durable workflow"
status: current
updated: 2026-09-15
anchors: [packages/orchestrator/src/workflows.ts, packages/application-control/src/scorecard/workflow-batch-driver.ts, apps/api/src/core/scorecard/temporal-batch-driver.ts]
---
# Temporal batch orchestration — a scorecard batch as one durable workflow

A scorecard batch has two drivers. The **in-process loop** (`InProcessBatchDriver`, entered through
`track`) lives inside one control-plane process and is made survivable by boot recovery
([batch-resilience.md](./batch-resilience.md)). The **workflow driver** is one Temporal workflow per batch:
the workflow owns the driver loop's position, and the control plane still does every piece of work.

## When a batch is workflow-owned

- The control plane builds a `TemporalBatchDriver` when `EVERDICT_TEMPORAL_ADDRESS` is set, unless
  `EVERDICT_TEMPORAL_BATCHES=0` opts back out (`apps/api/src/composition/scorecard.ts`).
- `ScorecardService.submit` stamps `orchestration.workflowId` (`everdict-batch-<scorecardId>`) on the record,
  then starts `scorecardBatchWorkflow` on task queue `everdict-eval`. If the start fails, the stamp is removed
  and the batch runs on the in-process loop — a Temporal outage never hangs a batch.
- Inline-dataset batches always take the in-process loop: the workflow re-plans from the dataset registry,
  which cannot see an inline dataset.
- Multi-trial batches take the workflow too; the plan is keyed by (case, trial).

## Shape

```
scorecardBatchWorkflow({ scorecardId, continueEvery?, rotateAtHistoryLength? })
  ├─ activity planBatch      → POST /internal/batches/:id/plan      → unfinished (caseId, trial?) items + concurrency
  ├─ lanes = min(concurrency, 64, slice size); each lane takes the next item:
  │    activity runBatchCase → POST /internal/batches/:id/case      → dispatch + settle one (case, trial)
  └─ activity finalizeBatch  → POST /internal/batches/:id/finalize  → aggregate, persist, notify
```

- The activities (`packages/orchestrator/src/activities.ts`) are plain HTTP calls to the control plane with
  `x-internal-token`; the worker needs `EVERDICT_API_URL` and `EVERDICT_INTERNAL_TOKEN`. The control-plane side
  is `WorkflowBatchDriver` (`planBatch` / `runBatchCase` / `finalizeBatch`).
- The workflow holds only ids and counters; all I/O happens in activities.
- Activity policy: 1 h start-to-close, 1 min heartbeat timeout (`runBatchCase` heartbeats while the control
  plane runs the case), at most 10 attempts with 5 s–1 min backoff. That retry covers **transport** failures —
  the control plane restarting or unreachable.
- **Case-level retry is not Temporal's.** It stays in `WorkflowBatchDriver.runBatchCase` (the attempt loop
  over `failure.retryable`), with spillover, tail speculation and OOM boost beside it — the same failure
  taxonomy as the in-process loop. Temporal's retry is not the argument for this driver. The arguments are a
  driver position that survives any process, and batch ownership that does not depend on one control plane.
- `planBatch` is idempotent: it returns only unfinished work. A worker that replays history, or an execution
  continued as new, gets exactly the remainder.
- TRUST-143 (`apps/api/src/trust/temporal-batch-replay.trust.test.ts`) certifies the chain: a worker killed
  mid-case, the case re-run by another worker, and the batch finalized exactly once.

## Ownership, recovery and cancellation

- Boot recovery leaves a workflow-owned batch alone: when `ScorecardBatch.isWorkflowOwned()` is true
  (`orchestration.workflowId` is present), `resume` answers `resumed` without driving the batch.
- Supersede and cancel call `TemporalBatchDriver.cancel` as part of the batch teardown. The call is
  best-effort, and Temporal cancels the workflow cooperatively.
- The scorecard detail page shows the workflow id, linked into the Temporal UI when the web's
  `TEMPORAL_UI_URL` is set. `GET /ops/driver/batch/:id` (with `/cancel` and `/terminate`) addresses the
  workflow by scorecard id — see [orchestration.md](../orchestration.md).

## History budget — continue-as-new

Each case adds a handful of history events, more when transport retries happen. So a batch of several
thousand cases would hit Temporal's per-execution limits (50K events / 50MB). The workflow therefore rotates:

- **By case count**: one execution runs at most `continueEvery` items (default 500; the control plane
  passes `EVERDICT_TEMPORAL_BATCH_CONTINUE_EVERY` in the start args), then calls `continueAsNew` with the same
  input under the same workflow id.
- **By history pressure**: lanes stop taking new items when the server sets `continueAsNewSuggested` or
  `historyLength` reaches `rotateAtHistoryLength` (default 20 000; `EVERDICT_TEMPORAL_BATCH_ROTATE_HISTORY`).
  In-flight activities drain first, then the execution continues as new.

Early rotation is safe because the continued execution calls `planBatch` again.

## Retry-failed on the workflow

A `retry-failed` batch is workflow-owned too when the driver is configured and the source batch is
single-trial (`RetryFailedBatch`). The carried passes, plus any re-collected recoveries, are committed as
child runs before the workflow starts. `planBatch` then drives only the re-dispatch remainder, and
`finalizeBatch` aggregates everything. OOM escalation reaches `runBatchCase` through
`origin.memoryBoostMb`. If the start fails, the retry runs on the in-process loop.

## Not in the workflow

- Adaptive batch concurrency — in-process loop only; the workflow bounds its own lane count.
- Placement, fairness and capacity — the control plane's `Scheduler`, unchanged.
- Judge and export streaming — per-case steps inside `runBatchCase`.
