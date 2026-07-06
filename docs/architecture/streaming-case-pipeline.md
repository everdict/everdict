# Streaming case pipeline — kill the batch barriers, release compute early

> **Status: doc-first SSOT.** Successor to
> [execution-scoring-orchestration](./execution-scoring-orchestration.md) (which separated the *concerns*:
> execute / score / orchestrate). This doc removes the remaining **serialization** between those concerns:
> phase barriers in the batch pipeline and sandbox occupancy during non-compute work. Related:
> [trace-sink](./trace-sink.md) (the observability round-trip this pipeline feeds).

## Problem — measured, not hypothetical

The batch pipeline is already async at the API surface (202 + background `track()`), fanned out per case
(`runSuite` mapLimit), and backpressured at placement (`Scheduler` WFQ). What remains serial:

1. **Judge application is a barrier AND a serial loop.** `ScoringService.applyJudges` runs
   `for judge × for case`, one `await` at a time, and only starts after the *entire* batch finishes
   (`scorecard-service.ts` phase `judges`). 100 cases × 2 judges × ~5s LLM call ≈ 17 min of pure serial tail;
   the slowest case gates judging of every other case.
2. **Phase barriers.** dispatch-all → judge-all → offload → export → finalize. Sandbox-bound work (execution)
   and I/O-bound work (judge LLM calls) never overlap.
3. **The sandbox is held during non-compute work.** In `runner.runCase` the compute handle stays provisioned
   through grading — including graders that never touch the environment (trace/snapshot/judge). The most
   expensive resource (an isolated job) idles on network/LLM latency. Same shape in
   `ServiceTopologyBackend`: the browser target is held through grading.

## Principles

1. **A barrier is legitimate only where cross-case aggregation demands it** — `summarizeScorecard` /
   `scorecardModels` / persist (finalize). Everything per-case streams.
2. **Compute is the scarce resource.** Release it at the last instruction that *needs* it. Scoring over
   observations (trace + snapshot) is I/O-bound and must not hold a sandbox.
3. **Observations are materialized before release** — anything a post-release grader needs from the
   environment (today: the os-use screenshot ref) is captured into the observation bag first.
4. **No semantic drift.** Per-case score order stays deterministic; judge failure semantics
   (`error.phase="judges"`), supersede, and "missing judge = silent skip" are preserved.

## Design

### D1 — per-case scoring core + case-axis parallelism (`ScoringService`)

- `resolveJudges(tenant, selections)` — resolve specs **once** up front (missing → skipped here, not per case).
- `applyJudgesToCase(tenant, evalCase, specs, result, runtime?)` — judges applied **sequentially within a
  case** (deterministic score order), cases run **in parallel** (bounded, `caseConcurrency` default 4 —
  provider rate-limit guard).
- `createJudgeStream(tenant, dataset, judges, runtime?)` → `{ push(result), settle() }` — the streaming unit.
  `push` fires a bounded task immediately; `settle` joins all tasks and rethrows the first error.
  `applyJudges` (kept for ingest + back-compat) = push all results, settle. One core, two consumption modes.

### D2 — streaming judges in the live batch (`ScorecardService.track`)

- Specs pre-resolved before `runSuite`; `onResult` pushes each finished case into the judge stream —
  **judging overlaps dispatch**, the slowest case no longer gates the fastest.
- After `runSuite`: `phase = "judges"` → `await stream.settle()` — the barrier collapses to a join.
  A judge task error still lands on `error.phase="judges"` after dispatch completes (same as today).
- Supersede: after abort no further cases are pushed; already-launched tasks settle before persisting
  (avoids racing `writeBackResults` against in-flight score mutation). Judge scores on a superseded partial
  result are harmless — `superseded ≠ succeeded`, no baseline/leaderboard pollution.

### D3 — early compute release (`runner.runCase` + topology backend)

- `Grader` contract gains an optional marker: **`needsCompute?: boolean`** — declared `true` by the outcome
  family that executes commands in the environment (`tests-pass` / `command` / `swe-bench` / `script-score`).
  Undeclared = observation-only (trace/steps/cost/latency/browser/judge).
- `runCase` order: run → snapshot → grade `needsCompute` graders → **materialize** the os-use screenshot
  (ref → base64, into the *grading* snapshot only — the stored snapshot stays ref-only, no record bloat) →
  **release compute** → grade observation-only graders (judge LLM waits no longer hold the sandbox).
  The `finally` release stays (idempotent via flag) — the invariant "ComputeHandle is always released in a
  finally" is unchanged.
- `ServiceTopologyBackend`: dispose the browser target right after `observe()` (observations are in hand),
  before grading — same idempotent-release pattern.

### D4 — 2-phase trace collection (`traceRef`)

The user-facing model: **phase 1 = run the harness against the dataset; phase 2 = collect the trace the
harness exported to an observability platform near the runtime.** Two modes, one knob:

- **Contract.** `RunContext.runId` — `runCase` mints (or receives) the correlation id and hands the *same*
  value to `run()` (harness injects it as `ASSAY_RUN_ID`/`assay.run_id`) and to collection.
  `EvaluableHarness` gains two optional hooks: `traceSource()` (the platform coordinates + collect mode,
  from the harness spec) and `collectTrace(runId)` (the actual pull). `CommandHarnessSpec.trace` gains
  **`collect: "job" | "control-plane"` (default `"job"`)**.
- **Mode `job` (default — no regression, in-job pull moved after release).** `CommandHarness.run()` no longer
  pulls at the generator tail; `runCase` calls `collectTrace(runId)` **after compute release** and appends the
  platform events before observation-only grading. The sandbox is free during OTel/MLflow flush lag. Outcome
  (`needsCompute`) graders grade before release on the exec-only trace — they never read the trace, so this
  is semantically identical.
- **Mode `control-plane` (opt-in — the job ends at execution end).** The agent skips collection AND
  observation-only grading entirely; the `CaseResult` carries compute-bound scores + snapshot (os-use
  screenshot materialized *into* the result, since the control plane can't reach the sandbox) +
  **`traceRef {kind, endpoint, runId}`**. `executeCase` (shared by run + scorecard) completes the result:
  pull via `buildTraceSource` → append events → reconstruct the deferred observation graders from
  `case.graders` (same `needsCompute` partition rule, both sides deterministic) → grade. Settle
  (`costOf`) runs after completion, so cost accounting sees the collected `llm_call` events. Judges then
  stream over the completed result unchanged (D2).
- **Why the knob is on the harness spec (locality).** The trace endpoint is often cluster-internal
  (reachable only from the runtime network) — that is exactly why traces are loaded "near the runtime".
  Only the harness owner knows whether the endpoint is control-plane-reachable; default `job` keeps pulls
  inside the runtime network.
- **Failure semantics.** `job` mode: pull failure fails the case (unchanged). `control-plane` mode:
  **soft-degrade** — an `error` event is appended and observation grading proceeds; execution artifacts
  (snapshot + ground-truth scores already produced in-job) are never thrown away, and `caseVerdict`
  authority ranking means a missing trace cannot overturn a ground-truth pass. An inline `judge` *case
  grader* cannot be reconstructed control-plane-side without its Judge → explicit `skipped` score (registry
  judges — the main path — are unaffected).

## Follow-ups (deliberately not in this pass)

- **`trace.authSecret` for control-plane collection** — deferred pulls hit the endpoint unauthenticated
  today (in-network pulls never needed auth); a SecretStore ref on `CommandTraceSpec` closes that when a
  tenant's platform requires it.
- **Collection retry/backoff** — control-plane collect is a single fetch (job teardown + result transport
  already absorb typical flush lag); add bounded retry if real platforms prove laggier.
- **Command trace kinds beyond otel/mlflow** — langfuse/langsmith/phoenix exist in `buildTraceSource`;
  extending `CommandTraceSpec` is mechanical once someone needs it.
- **Per-case sink export streaming** — export after each case's judging instead of post-batch; today's export
  is one fast HTTP pass, low value until sinks dominate the tail.
- **Durable batch orchestration on Temporal** — per-case activities give restart resilience + horizontal
  control-plane scale; extend the existing runs pattern when batch sizes demand it.
- **Capacity-derived dispatch concurrency** — `runSuite` default 4 is static; derive from
  `Scheduler.capacity()` when large clusters go underutilized.

## Non-goals

- Force-killing in-flight backend jobs on supersede (separate problem, tracked in github-actions-trigger).
- Parallelism *within* a case's judges (usually 1–2 judges; case axis dominates).
- Changing where judges run (control-plane co-locate via `placement` stays as designed in
  judge-placement-locality).
