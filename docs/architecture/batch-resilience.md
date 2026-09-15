---
kind: wiki
title: "Batch resilience — transient retry · restart resume · retry-failed"
status: current
updated: 2026-09-15
anchors: [packages/application-control/src/run-suite.ts, packages/application-control/src/scorecard/recovery-planner.ts, packages/application-control/src/scorecard/retry-failed-batch.ts, packages/application-control/src/scorecard/resilient-case-runner.ts, packages/domain/src/failure/case-failure.ts]
---
# Batch resilience — transient retry · restart resume · retry-failed

Team-scale evaluation means hundreds of cases per batch (WebVoyager alone is 601), many users
submitting concurrently, and long wall-clocks. At that scale three failure classes stop being edge
cases: a **transient dispatch error** (alloc placement blip, node drain, network hiccup), a
**control-plane restart** mid-batch, and a **completed batch with failures worth re-running**. This
page describes how batches absorb all three without losing finished work.

The invariant behind all three: **finished case results are durable and never re-run; unfinished
cases are always re-runnable.** Results persist per case (child runs with commit receipts), so a batch can be
reconstructed from `{committed child results} + {remaining cases}` at any time.

This page covers the in-process batch loop and what it shares with the workflow driver; the workflow driver
itself is [temporal-batch-orchestration.md](./temporal-batch-orchestration.md).

## 1. Transient dispatch retry (`runSuite` retries)

`runSuite(suite, version, dispatch, {retries})` retries a case whose dispatch **throws** — up to
`retries` extra attempts with linear backoff — but only when `classifyFailure` calls the failure
`retryable`. A throw is an infra signal (backend error, placement failure, network); a `CaseResult` with
failing scores is a *legitimate eval outcome* and is **never** retried here. Once the attempts run out, the
failure becomes a classified failed `CaseResult`; the other cases are unaffected.

The control plane passes `retries` from the submit body (`POST /scorecards`, MCP `run_scorecard`;
default **1**, max 5). `0` means fail fast.

## 2. Restart resume (startup recovery → `ScorecardService.resume`)

Boot recovery (`recoverInterrupted`) **resumes** an interrupted batch instead of tombstoning it. For each
active scorecard record it claims, `RecoveryPlanner.seedFromLedger`:
- carries in every child whose attempt **committed** and that holds a result — `failed` children too, since a
  failed case is a measured outcome;
- tries to **adopt** each mid-flight (`queued`/`running`) child by the runtime work handle the attempt ledger
  recorded at dispatch (`ManagedWorkControl.adoptWork(work)`): a job that outlived the restart hands back its
  result and is not re-run. A child with no recorded handle is re-dispatched. A ledger or cluster that cannot
  answer defers the batch (`retry_later`) instead of re-dispatching work that may still be live;
- re-runs only the remaining (case, trial) executions, appends a `resume` step to the progress timeline, and
  then aggregates, judges and exports exactly like a first run.

Recovery claims a record only when the replica driving it is **gone**, and a Temporal-owned batch is left to
its workflow — see [multi-replica.md](./multi-replica.md).

Everything resume needs is on the record: dataset/harness refs, `runtime`, `subset`, and **`orchestration`**
(`{judges, graders?, judge?, concurrency, retries, trials?, workflowId?, traceSink?, oomAutoBoost?}`, first
added by migration `0049_add_scorecard_orchestration`) persisted at submit. A record without `orchestration`
cannot be resumed faithfully and is tombstoned `failed (INTERRUPTED)`; so is a batch whose dataset or harness
no longer resolves.

### Single-run durability (standalone runs resume too)

`RunService.submit` persists the **effective case body** — placement target already injected — as
`RunRecord.caseSpec` (migration `0051_add_run_case_spec`). Boot recovery resumes a standalone run in this order:

1. **Adopt** — try each work handle the run's attempts recorded; a job that outlived the restart settles the
   run from its harvested result, with zero re-run.
2. **Re-dispatch** — nothing adoptable: re-drive the run from the persisted `caseSpec`. The persisted case is
   the effective one, so it routes back to the same runtime.
3. **Tombstone** — a record with no `caseSpec` is settled `failed (INTERRUPTED)`.

An unreadable attempt ledger defers the run rather than re-dispatching it. Boot log:
`▶ boot recovery: batches resumed N · batches failed(INTERRUPTED) M · runs resumed N · runs failed M · …`.

## 3. Retry-failed (`POST /scorecards/:id/retry`, MCP `retry_scorecard`)

For a **terminal** batch with failures: create a **new** scorecard that re-runs **only the failed
cases** and **carries over the passing results** from the source. The new record is a full,
directly comparable scorecard (same case set → pass rates and diffs line up), stamped
`origin.retryOf: <source id>` for lineage. The source record is never mutated. A multi-trial or superseded
source cannot be retried this way (`ScorecardBatch.canRetryFailed`).

Carried-over results keep their scores (including judge scores) verbatim; only re-run cases go
through dispatch → judge → export again. "Failed" = `caseVerdict(result) !== true` (explicit FAIL
and no-verdict cases both re-run).

To repair the record you already have instead of forking a new one, `POST /scorecards/:id/retry-cases` (MCP
`retry_scorecard_cases`) re-runs named cases inside the same scorecard —
[in-place-case-retry-spec.md](./in-place-case-retry-spec.md).

## Failure taxonomy (WHERE it died × WHOSE fault)

`CaseResult.failure` = `{stage, class, code, message, retryable}` (`@everdict/domain` `classifyFailure`):
**infra** (platform's fault — placement, network, OOM, log race; usually retryable) · **config** (workspace
setup — missing secret, bad pin; retrying changes nothing) · **harness** (its own install/run crash; same input →
same failure) · **agent** (a legitimate grader verdict — never a "failure", never auto-retried). `CANCELLED` is
infra and never retryable: a deliberate stop is not re-dispatched. Backends stamp signals the classifier reads:
`OOM_KILLED` (K8s pod `OOMKilled` reason / Nomad alloc OOM events) is FATAL infra — same limits, same death —
so the transient retry skips it and the message says to raise `resources.memoryMb`.

`retry-failed` AUTO-ESCALATES: an OOM_KILLED case re-dispatches with `resources.memoryMb` doubled, on the job
only (the registry spec is never mutated). The applied value is recorded per case on `origin.memoryBoostMb`,
and the next retry starts from it, so consecutive retries compound (64 → 128 → 256 …) up to a 16 GB cap
(`OOM_ESCALATION_CAP_MB`) — past the cap the fix is a real spec change.

**In-batch auto-boost (opt-in)** removes the human round-trip per doubling: with `oomAutoBoost: true` on the
batch (HTTP/MCP submit knob, persisted on `orchestration` so resume keeps it), an OOM_KILLED case
re-dispatches INSIDE the running batch with doubled job-only memory, compounding up to the same cap and then
surfacing the OOM (`executeWithOomBoost`, used by both drivers). Off by default because every boost re-runs the
case. Boosts surface as progress steps (`<case>: OOM auto-boost 64 → 128Mb (in-batch retry)`) and the
`everdict_oom_escalated_total` counter.

**Stages survive the process boundary**: the job runner catches in-job errors and emits a CLASSIFIED
CaseResult through the sentinel (`stageForError`: install · run · grade · collect · dispatch), so a setup break
lands as `{install, harness, retryable:false}` instead of a backend-side "sentinel not found". The self-hosted
runner does the same: `runLeaseWorkers` submits a classified failed CaseResult with `submit_job_result`, and
`fail_job` is only the fallback for malformed jobs or a failed submit.

## Stage-aware resume — a collect failure never re-runs the agent

Trace pull after the run is its own stage, and its failure KEEPS THE WORK: the agent ran and compute-bound
scores exist — only observability failed. `runCase` returns the result stamped
`{collect, infra, TRACE_COLLECT_FAILED, retryable}` with the ground-truth scores, the snapshot, and a
`traceRef` (the frozen re-collect coordinates), while observation scoring waits for the trace. Recovery
escalates in steps, none of which re-runs the agent:

1. `executeCase` immediately retries the pull from the control plane (`collectDeferredTrace`, the same step as
   `collect="control-plane"`): the control plane's network often reaches what the sandbox couldn't. Success
   clears the classification and completes the deferred scoring.
2. A collect-classified case is retryable even when its ground-truth verdict PASSED (judges never saw a
   trace). `retry-failed` partitions by stage: collect-stage cases with a `traceRef` are re-COLLECTED (pull →
   judge → carried as recovered results) while everything else re-dispatches. Cases still unrecovered keep
   their classification verbatim.

Consumers: `runSuite` retries only `retryable` classes; retry-failed takes a class filter
(HTTP `?class=infra` · MCP `failure_class`) so a cluster incident re-runs exactly its casualties while agent
FAILs stay carried as legitimate results. Harnesses declare their weight (`resources {cpu, memoryMb}` on the
command spec/template → Nomad task resources / K8s requests=limits) so heavy harnesses bin-pack correctly and
starvation classifies as infra instead of poisoning pass rates.

The declared weight also drives ADMISSION: a runtime may declare an envelope (`RuntimeSpec.maxConcurrent`,
`memoryBudgetMb`, `cpuBudget`) and the `Scheduler` caps the sum of in-flight harness-declared memory/cpu
against it — a heavy batch queues at the control plane when the envelope is full even with slots free, instead
of over-committing the cluster. Harnesses that declare no weight are admitted outside the budget.

## Cross-runtime sharding

`runtime` accepts a comma-separated list — cases are spread across the listed runtimes at dispatch (per-case
`placement.target`), so one 601-case batch drains a Nomad pool and a K8s pool at once.

## Runtime spillover + circuit breaker

A sharded batch survives a runtime dying MID-batch without human intervention: a retryable INFRA dispatch
failure moves the case to the next healthy runtime of the same user-selected shard list (`executeWithSpillover`,
run for both drivers by `resilient-case-runner.ts`). A per-runtime `CircuitBreaker` (`@everdict/domain`, keyed
`tenant:runtimeId`, shared across batches) remembers the outage: after 3 consecutive infra failures (default)
the circuit opens for a 30 s cooldown (default), and later cases assigned to the dead runtime skip straight to a
healthy one. After the cooldown one probe goes through (half-open); success closes the circuit, failure re-arms it.

What never spills: fatal infra (OOM — the same resources die anywhere), config, harness, and agent FAILs.
Single-runtime batches pass through unchanged (the transient retry owns them). Provenance follows the case:
the child run's `runtime` is rewritten to the runtime that ACTUALLY ran it, and a
`runtime spillover a → b (code)` progress step records each move.

## Cancellation and supersede teardown

The cooperative abort only stops cases not yet fired, so stopping a batch (user cancel, or supersede by a
newer fire of the same PR) runs a teardown (`ScorecardService.stopInFlight`): cancel a Temporal-owned workflow,
drop the batch's still-queued scheduler entries (`Scheduler.cancelQueued`, keyed by `CaseJob.batchId`),
revoke self-hosted lease jobs, and stop each running child's managed job by its recorded work handle
(`WorkAddressable.killWork`). A kill that fails leaves the teardown owed, and the cancellation reconciler
retries it.

## History-informed shard split (speculation's preventive half)

Uniform round-robin gives a 3×-slower runtime the same share. The split is weighted by history
(`weightedTargets`, `shard-weights.ts`): per-target duration medians from recent succeeded batches of the same
harness, used as RELATIVE ratios — only batches that themselves spanned ≥2 of the current targets contribute,
each normalized by its own batch mean, so version/workload differences cancel. Distribution is a deterministic
smooth weighted round-robin; a target with no history gets the average weight (unknown ≠ slow), and no history
at all gives the uniform split. The speculation threshold's cold start is seeded from same id@version history.

## Adaptive batch concurrency — pressure shrinks the width, recovery restores it

A batch's configured concurrency is a fixed worker count in `runSuite`; under pressure, full-width fan-out
piles work onto a struggling system. An `AdaptiveConcurrencyGate` inside the batch's dispatch closure shrinks
the EFFECTIVE parallelism and restores it by itself — the pressure factor is re-sampled at every
acquire/release, so there is no timer and no reset path:

- **runtime circuit open** (one of the batch's shard runtimes): width × 0.5; ALL open → floor of 1 — a
  trickle probe that keeps running, so the moment a probe succeeds the circuit closes and the width restores.
- **scheduler queue spike** (queue depth > `EVERDICT_QUEUE_PRESSURE`, default 64): width × 0.5.

Shrinking never cancels in-flight work, and `runSuite`'s worker count stays the hard ceiling. Transitions
surface as progress steps (`concurrency shrunk 4 → 2 …`) and `everdict_concurrency_adapted_total{direction}`.
In-process batches only — the workflow driver bounds its own lanes.

## Tail speculation — stragglers duplicate, first result wins

Spillover reacts to failure; speculation reacts to SLOWNESS. Once every case has been dispatched (pure tail),
a case in flight longer than `2 × median completed duration` (floored at 10 s) gets ONE duplicate dispatch on
another healthy runtime of the same shard list (`SpeculationController`, both drivers); the first result wins
and the loser is discarded (bounded double compute, tail only, never onto an open circuit). The winner's
runtime lands as the child run's provenance and a `tail speculation a ⇢ b` step records the duplicate. When
the duplicate wins, the loser's still-QUEUED scheduler entry is cancelled (rejected `CANCELLED`, never
dispatched).

## Chaos scenario suite (repeatable drills)

The recovery invariants above are codified as one repeatable script — `scripts/live/chaos-orchestration.mjs`
(a real control plane on an isolated `everdict_chaos` Postgres database + real Nomad; kill/restart cycles never
touch the dev control plane's records):

1. **CP SIGKILL mid-batch** → boot resume: finished results kept, in-flight jobs adopted, remainder
   re-dispatched, batch completes.
2. **CP SIGKILL mid-single-run** → single-run durability: `runs resumed 1`, adopt or caseSpec re-dispatch,
   run succeeds.
3. **Dead shard runtime** → spillover + circuit breaker + adaptive concurrency shrink, batch completes with
   every case result present.

The script is run by hand; it is not part of any gate.

## Shared core

A fresh submit, a resume and a retry-failed all enter the same in-process loop (`track` → `InProcessBatchDriver`)
and differ only in the seed (`TrackOptions.seed` / `seedRunIds`): a fresh submit has none, a resume carries the
committed children, a retry-failed carries the source's passes. Judge/export streaming applies to the re-run
cases only — seeds are already judged. The per-case resilience (spillover, OOM boost, speculation) lives in
`resilient-case-runner.ts`, shared with the workflow driver.

## Throughput note (the concurrency cap)

Per-batch `concurrency` accepts up to 512 on `POST /scorecards`. The **Scheduler** is the governor
(capacity-aware placement + tenant-fair WFQ + queue backpressure), and Nomad/K8s spread allocs across nodes
natively — so the submit-side value mostly means "how many cases this batch is willing to have in flight";
actual placement is still admission-controlled per backend capacity.
