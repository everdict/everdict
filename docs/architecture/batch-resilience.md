# Batch resilience — transient retry · restart resume · retry-failed

Team-scale evaluation means hundreds of cases per batch (WebVoyager alone is 601), many users
submitting concurrently, and long wall-clocks. At that scale three failure classes stop being edge
cases: a **transient dispatch error** (alloc placement blip, node drain, network hiccup), a
**control-plane restart** mid-batch, and a **completed batch with failures worth re-running**. This
doc is the SSOT for how batches absorb all three without losing finished work.

The invariant behind all three: **finished case results are durable and never re-run; unfinished
cases are always re-runnable.** Results persist incrementally (per-case child runs, D1 streaming),
so a batch can be reconstructed from `{done child results} + {remaining cases}` at any time.

## 1. Transient dispatch retry (`runSuite` retries)

`runSuite(suite, version, dispatch, {retries})` retries a case whose dispatch **throws** — up to
`retries` extra attempts with linear backoff. A throw is an infra signal (backend error, placement
failure, secret resolution, network); a `CaseResult` with failing scores is a *legitimate eval
outcome* and is **never** retried here. After the attempts are exhausted, the failure freezes into
the usual `dispatch/error` CaseResult (case isolation is unchanged).

The control plane passes `retries` from the submit body (`POST /scorecards`, MCP `run_scorecard`;
default **1**, max 5). `0` restores the old fail-fast behavior.

## 2. Restart resume (startup recovery → `ScorecardService.resume`)

Before: `recoverInterrupted` tombstoned every queued/running batch as `failed (INTERRUPTED)` — a
601-case batch that died at case 599 threw away 598 finished results.

Now boot recovery **resumes** interrupted batches instead: for each active scorecard record it
- collects done results from the batch's child runs (`status=succeeded` with a stored `result`),
- re-runs only the remaining selected cases (mid-flight children that died with the process are
  re-dispatched fresh — their child records are superseded by the new attempt),
- appends a `resume` step to the progress timeline, then aggregates/judges/exports exactly like a
  first run (already-judged done results keep their scores; only new results stream through the
  judge).

Everything resume needs is on the record: dataset/harness refs, `runtime`, `subset`, and the new
**`orchestration`** field (`{judges, judge?, concurrency, retries}`, migration
`0049_add_scorecard_orchestration`) persisted at submit. Records from before this field (no
`orchestration`) can't be faithfully resumed and keep the old tombstone path.

Standalone runs keep the tombstone behavior (a single run is cheap to resubmit; a batch is not).

## 3. Retry-failed (`POST /scorecards/:id/retry`, MCP `retry_scorecard`)

For a **terminal** batch with failures: create a **new** scorecard that re-runs **only the failed
cases** and **carries over the passing results** from the source. The new record is a full,
directly comparable scorecard (same case set → pass rates and diffs line up), stamped
`origin.retryOf: <source id>` for lineage. The source record is never mutated (eval history stays
immutable — leaderboards/trends read records as written).

Carried-over results keep their scores (including judge scores) verbatim; only re-run cases go
through dispatch → judge → export again. "Failed" = `caseVerdict(result) !== true` (explicit FAIL
and no-verdict cases both re-run).

## Failure taxonomy (WHERE it died × WHOSE fault)

`CaseResult.failure` = `{stage, class, code, message, retryable}` (`@everdict/core` `classifyFailure`):
**infra** (platform's fault — placement, network, OOM, log race; usually retryable) · **config** (workspace
setup — missing secret, bad pin; retrying changes nothing) · **harness** (its own install/run crash; same input →
same failure) · **agent** (a legitimate grader verdict — never a "failure", never auto-retried). Backends stamp
signals the mapper reads: `OOM_KILLED` (K8s pod `OOMKilled` reason / Nomad alloc OOM events) is FATAL infra —
same limits, same death, so the transient retry skips it and the message says "raise resources.memoryMb".

**Stages survive the process boundary**: the agent entrypoint catches in-job errors and emits a CLASSIFIED
CaseResult through the sentinel (`stageForError`: HARNESS_INSTALL_FAILED→install · run · grade · collect ·
dispatch), so a setup break lands as `{install, harness, retryable:false}` instead of a mushy backend-side
"sentinel not found". The self-hosted runner path has the same parity: `runLeaseWorkers` submits a classified
failed CaseResult (`submit_job_result` with `failure` stamped) instead of a bare `fail_job`, which is now only
the fallback for malformed jobs or when the submit itself fails.

## Stage-aware resume — a collect failure never re-runs the agent

Trace pull after the run (`collectTrace`) is its own stage, and its failure KEEPS THE WORK: the agent ran,
compute-bound scores exist — only observability failed. `runCase` returns the result stamped
`{collect, infra, TRACE_COLLECT_FAILED, retryable}` with the ground-truth scores, the snapshot, and a
`traceRef` (the frozen re-collect coordinates: kind/endpoint/runId/authSecret-name/correlate), while
observation scoring defers with the trace (scoring steps/cost against a known-incomplete trace would be
silently wrong). Recovery then escalates in three steps, none of which re-runs the agent:

1. `executeCase` immediately attempts the pull control-plane-side (`collectDeferredTrace` — the same completion
   step as `collect="control-plane"`): the CP's network often reaches what the sandbox couldn't. Success sheds
   the classification and completes the deferred scoring; a pull exception classifies `{collect}` in BOTH
   collection modes (the CP mode used to soft-score observations against the incomplete trace).
2. A collect-classified case is retryable even when its ground-truth verdict PASSED (it is incomplete — judges
   never saw a trace). `retry-failed` partitions by stage: collect-stage cases with a `traceRef` re-COLLECT
   (pull → judge → carried as recovered results) while everything else re-dispatches. Still-unrecovered cases
   carry their classification verbatim — fix the platform, retry again.
3. Live e2e: 2 cases run with the OTel endpoint DOWN → `{collect}` + `tests_pass=true` preserved; endpoint
   brought up + spans injected under the frozen `everdict.run_id`s → retry = "re-running 0 failed case(s) …
   2 collect-failed case(s) re-collected without re-run (2 recovered)", Nomad job count unchanged (101→101).

Consumers: `runSuite` retries only `retryable` classes; retry-failed takes a class filter
(HTTP `?class=infra` · MCP `failure_class`) so a cluster incident re-runs exactly its casualties while agent
FAILs stay carried as legitimate results. Harnesses declare their weight (`resources {cpu, memoryMb}` on the
command spec/template → Nomad Task Resources / K8s requests=limits) so heavy harnesses bin-pack correctly and
starvation classifies as infra instead of poisoning pass rates.

The declared weight also drives ADMISSION, not just execution: a runtime may declare an envelope
(`RuntimeSpec.maxConcurrent` + `memoryBudgetMb`) and the `Scheduler` caps the sum of in-flight
harness-declared memory against it — a heavy batch queues at the control plane when the envelope is full even
with slots free, instead of over-committing the cluster and converting the overload into OOM/starvation
downstream. Undeclared harnesses are admitted outside the memory budget (opt-in by declaring). Live: 4×512Mb
cases on a 600Mb-envelope runtime = strict serialization (24s, completion gaps 6/6/6s) vs the same batch on an
unbounded runtime = full parallel (9s, gaps 0/0/0).

## Cross-runtime sharding

`runtime` accepts a comma-separated list — cases round-robin across the listed runtimes at dispatch (per-case
`placement.target`), so one 601-case batch drains a Nomad pool and a K8s pool at once. Live: 40 cases across
nomad+kind in 49s, 100% pass.

## Runtime spillover + circuit breaker

A sharded batch survives a runtime dying MID-batch without human intervention: a retryable INFRA dispatch
failure moves the case to the next healthy runtime of the same user-selected shard list (`executeWithSpillover`,
both the in-process loop and the Temporal `runBatchCase` path). A per-runtime `CircuitBreaker`
(`@everdict/backends`, keyed `tenant:runtimeId`, shared across batches) remembers the outage: after N
consecutive infra failures (default 3) the circuit opens for a cooldown (default 30s) and later cases assigned
to the dead runtime skip straight to a healthy one — no per-case re-discovery of the same outage. After the
cooldown, exactly one probe goes through (half-open); success closes the circuit, failure re-arms it.

What never spills: fatal infra (OOM — the same resources die anywhere), config, harness, and agent FAILs.
Single-runtime batches pass through unchanged (the transient retry owns them — there is nowhere to spill to).
Provenance follows the case: the child run's `runtime` is rewritten to the runtime that ACTUALLY ran it, and a
`runtime spillover a → b (code)` progress step records each move. Live: dead-nomad+kind shard, 8 cases → 8/8
pass, exactly 3 spill steps then breaker-open (the 4th dead-assigned case skipped silently to kind).

## Tail speculation — stragglers duplicate, first result wins

Spillover reacts to failure; speculation reacts to SLOWNESS (a slow-but-alive runtime holding its shard while
the rest of the pool idles). Once every case has been dispatched (pure tail — earlier would steal capacity from
undispatched work), a case in flight longer than `2 × median completed duration` (floored at 10s) gets ONE
duplicate dispatch on another healthy runtime of the same shard list (`SpeculationController`, both dispatch
paths); the first result wins, the loser is discarded (bounded double compute, tail only, never onto an open
circuit). The winner's runtime lands as the child run's provenance and a `tail speculation a ⇢ b` step records
the duplicate. Live: tight(600Mb envelope)+local shard, 8 cases → 18s (vs ~24s serialized tail), 2 speculations
fired — one duplicate WON (child runtime=local though assigned tight), one primary won (duplicate discarded),
8/8 with no double-counted results.

## Shared core

All three paths run through one seeded batch loop (`track` refactored around
`{seedResults, casesToRun}`): a fresh submit is `seed=[]`, resume is `seed=done children`,
retry-failed is `seed=source passes`. Judge/export streaming (D1–D5) applies to the re-run cases
only — seeds are already judged.

## Throughput note (why the concurrency cap moved)

Per-batch `concurrency` used to cap at 64. On a real cluster the **Scheduler** is the correct
governor (capacity-aware placement + tenant-fair WFQ + queue backpressure), and Nomad/K8s spread
allocs across nodes natively — so the submit-side cap is now 512 and mostly means "how many cases
this batch is willing to have in flight"; actual placement is still admission-controlled per
backend capacity. Verified live: see `scripts/live/orchestration-resilience.mjs`.
