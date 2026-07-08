# Temporal batch orchestration — SHIPPED (live-verified vs a real dev Temporal)

> Status: implemented per this design and live-verified 2026-07-08 — worker SIGKILL mid-batch → a new
> worker replays the history and finishes the workflow (W1); control-plane SIGKILL mid-batch → the
> activities retry against the restarted CP, boot recovery respects workflow ownership ("batches
> resumed 1", no double-drive), 24/24 cases complete with zero loss or duplication (W2). Opt-in via
> EVERDICT_TEMPORAL_ADDRESS + EVERDICT_TEMPORAL_BATCHES=1; a failed workflow START degrades
> gracefully to the in-process loop.

## Why (and why not yet)

Today a batch's driver loop (`ScorecardService.track`) lives **in-process** in one control plane.
The resilience layer (docs/architecture/batch-resilience.md) makes that survivable — results persist
per case, boot recovery resumes interrupted batches, retry-failed re-runs casualties — so a single
control plane now rides out its own restarts and cluster incidents. What in-process tracking cannot
give: **more than one control plane** (HA / rolling deploys with zero batch ownership gaps),
**driver-loop survival independent of any process**, and **per-step observability** of a batch as a
first-class workflow. That is Temporal's exact shape, and the worker/activity split already exists
(`@everdict/orchestrator`: workflow = deterministic, activity = `dispatchCase`).

The resilience layer was built first deliberately: it is the fallback story when Temporal is *not*
deployed (self-hosters, dev), and the seeded track loop it produced is precisely the state machine
the workflow needs.

## Shape

One batch = one workflow (`scorecardBatch`), one case = one activity (`dispatchCase`).

```
scorecardBatchWorkflow(input: {scorecardId, tenant, dataset ref, harness ref, judges, judge,
                               runtimes[], concurrency, retries, seed caseIds})
  ├─ activity resolveBatch()          → cases minus seeds (the same seeded-loop inputs, resolved fresh)
  ├─ for case in cases (bounded by concurrency, workflow-side semaphore):
  │    activity dispatchCase(job)     → CaseResult   (retry policy: ONLY when classifyFailure().retryable —
  │                                     the activity rethrows fatal classes as non-retryable ApplicationFailure)
  │    activity settleCase(result)    → child-run write-back + judge stream push + export push
  └─ activity finalizeBatch()         → aggregate/summarize/persist/notify
```

- **Determinism**: the workflow holds only ids and counters; every I/O (registry resolve, dispatch,
  judge, persist) is an activity — same rule the repo already enforces for `workflows.ts`.
- **Failure classes map to Temporal retry policies**: `retryable` infra → activity retry with
  backoff (replaces `runSuite`'s inline retry); `config`/`harness`/fatal-infra → non-retryable
  `ApplicationFailure` carrying the `CaseFailure` payload — the case settles as a classified failure
  exactly as today.
- **Resume for free**: workflow history replaces `orchestration`+child-run reconstruction. Boot
  recovery stays for the non-Temporal deployment; when `EVERDICT_TEMPORAL_ADDRESS` is set, submit
  starts the workflow instead of `void this.track(...)` and recovery skips Temporal-owned batches
  (they own themselves).
- **Supersede / cancel** → workflow cancellation (cooperative, same semantics as the AbortController).
- **Sharding** stays submit-side (per-case `placement.target` round-robin) — the workflow doesn't
  care where a case lands; the Scheduler/RuntimeDispatcher path is unchanged inside `dispatchCase`.

## Increment plan (next slice)

1. `scorecardBatchWorkflow` + activities in `@everdict/orchestrator` beside the existing worker;
   reuse `executeCase`/`ScoringService` as activity bodies (no logic forks — the service methods are
   already transport-free).
2. `ScorecardService.submit`: `temporalDriver?` dep — when configured, start the workflow with the
   same persisted `orchestration` inputs; `track` stays as the in-process driver otherwise.
3. Live e2e vs the real dev Temporal (`temporalio/temporal` — the scheduled-evals harness already
   drives one: `scripts/live/scheduled-pinch-temporal.mjs`): kill the WORKER mid-batch → a new
   worker picks the workflow up with zero lost cases; kill the control plane → same.
4. Queue view: Temporal-owned batches surface `workflowId` on the record for deep-linking.

## History budget — continue-as-new

One case ≈ a handful of history events (activity scheduled/started/completed × transport retries), so an
unbounded multi-thousand-case batch would walk into Temporal's per-execution history limits (50K events /
50MB). The workflow processes at most `continueEvery` cases per execution (default 500;
`EVERDICT_TEMPORAL_BATCH_CONTINUE_EVERY` on the CP feeds the start args) and then `continueAsNew`s with the
same input. `planBatch`'s idempotence (unfinished-only) is what makes this trivially correct — the continued
execution re-plans and receives exactly the remainder, with a fresh history, under the same workflowId.

Live e2e: 12-case batch with `continueEvery=5` → plan steps "Running 12" → "Running 7 (5 kept)" →
"Running 2 (10 kept)"; `temporal workflow list` shows ContinuedAsNew ×2 → Completed on one workflowId;
12/12 pass.

## Retry parity

`retry-failed` batches are workflow-owned too (a CP restart mid-retry must not lose them): the carried seeds
(passes + re-collected recoveries) are MATERIALIZED as succeeded child runs before the workflow starts, so the
idempotent `planBatch` naturally drives only the re-dispatch remainder and finalize aggregates everything. The
OOM escalation boost rides `origin.memoryBoostMb` → batch context → `runBatchCase`, identical to the in-process
loop. Start failure degrades to the in-process loop, same as submit. Live: an OOM retry chain ran entirely
workflow-owned (each retry its own Completed workflow), escalated 64 → 128 → 256 and passed.

## Non-goals

- Moving judge/export streaming into Temporal (they are per-case activities already chained after
  dispatch — no barrier to remove).
- A second tenancy/fairness layer inside Temporal: WFQ/capacity stay in the Scheduler; Temporal owns
  durability of the *driver loop*, not placement.
