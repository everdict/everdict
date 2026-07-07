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
  value to `run()` (harness injects it as `EVERDICT_RUN_ID`/`everdict.run_id`) and to collection.
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
- **Auth (`trace.authSecret`).** A SecretStore *name* on the spec (value = verbatim `Authorization` header,
  the pull-ingest convention). `job` mode: `resolveHarnessSecrets` resolves it into transient `trace.auth`
  at dispatch (the agent can't reach the SecretStore; same discipline as env `{secretRef}` — value in the
  job payload only, never the registry). `control-plane` mode: the *name* rides on `traceRef.authSecret`
  (values are never persisted — `CaseResult` is stored) and `collectDeferredTrace` re-resolves via
  `secretsFor(tenant)`; a missing secret is a visible soft-failure, never a silent unauthenticated pull.
- **Retry (flush lag).** Both collect paths retry an *empty* pull (3 attempts, 2s backoff — emptiness is
  the flush-lag shape; hard errors stay conclusive). A still-empty control-plane collect appends an `error`
  event naming the correlation key instead of silently scoring 0.
- **Tag correlation (`correlate:"tag"`, mlflow).** Real platforms mint their own trace ids, so an
  everdict-minted `runId` can never equal one. A real instrumented agent instead tags its trace with
  `everdict.run_id` = `$EVERDICT_RUN_ID` (SDK `set_trace_tag` = `PATCH /api/3.0/mlflow/traces/{id}/tags`), and
  `MlflowTraceSource` resolves it via `POST /api/3.0/mlflow/traces/search` (backtick tag filter;
  `locations` is required → `trace.experiment` must scope the search). Default `"id"` keeps the
  runId=trace-id (pull-ingest) convention. Live-verified as S4 (below).

### D4 — verified live (real MLflow 3.14, `scripts/live/trace-collect-mlflow.mjs`)

The script boots `ghcr.io/mlflow/mlflow:v3.14.0` (docker, auto-cleaned; or `MLFLOW_ENDPOINT`), seeds
"instrumented-agent" traces via `MlflowTraceSink` (create + OTLP spans — the sink-e2e-verified path), then:
**S1** `collect="job"` — real `runCase`+`CommandHarness`+`LocalDriver`; the command sees the injected
`EVERDICT_RUN_ID` (round-trips into the git-diff snapshot) and `collectTrace(runId)` pulls the real spans
post-release (llm_call 42/7 tokens → steps/cost derived). **S2** `collect="control-plane"` — the job returns
only `traceRef` + ground-truth scores; `executeCase` pulls from real MLflow and grades the deferred
steps/cost (no double-scoring). **S3** dead endpoint → soft-degrade (`error` event, ground-truth preserved). **S4** `correlate:"tag"` —
the seeded trace is tagged `everdict.run_id` (the real-SDK contract) and an everdict-minted `runId` (≠ trace id)
resolves through `traces/search` to the real spans, completing the deferred grading.
All PASS 2026-07-06.

### D4 — command trace kinds are the full 5 (shipped; phoenix live-verified)

`CommandTraceSpec` accepts **otel | mlflow | langfuse | langsmith | phoenix** — the same 5 kinds as
`buildTraceSource`, which `CommandHarness.collectTrace` now uses directly (one factory, adapter-owned auth
header conventions: otel/mlflow verbatim `Authorization`, langsmith `x-api-key`). Phoenix requires
`project` (spans are only addressable per project) — it rides `traceSource()` → `traceRef.project` →
`TraceSourceConfig.project`, converging with mlflow's `experiment` on the config side. Live-verified vs a
real Arize Phoenix (`scripts/live/trace-collect-phoenix.mjs`, docker-booted): P1 `collect="job"` post-release
pull round trip + P2 `collect="control-plane"` completion, both PASS 2026-07-07.

### D4 — OTel tag correlation (shipped; Jaeger live-verified, the full real-agent round trip)

`CommandTraceSpec` otel gains **`correlate:"id"|"tag"` + `service`** (mirroring mlflow's tag mode).
`OtelTraceSource` in tag mode searches the **Jaeger query API**
(`GET /api/traces?service=…&tags={"everdict.run_id":…}&limit=1` — verified vs real Jaeger 1.62: the `tags`
filter matches **resource/process tags**, `service` is required, and the search response embeds full spans →
one request, reusing the existing `{data:[{spans}]}` parser). OTLP-native backends without a search API stay
id-correlated. Live e2e (`scripts/live/trace-collect-otel.mjs`) proves the **full real-agent contract with
zero id coordination**: no seeding, no injected runId — `runCase` mints the key, the command (a real
OTLP-exporting script) mints its *own* trace id and sets only the `everdict.run_id` resource attribute, and both
collect modes (O1 job / O2 control-plane) resolve it by tag search. PASS 2026-07-07.

### D5 — per-case sink export streaming (shipped)

The trace-sink export (the last remaining batch barrier) now streams: each case is exported to the
harness-selected platform **the moment its judging completes**, so the team sees traces/scores appear in
their MLflow/Langfuse case-by-case *while the batch runs*, and a batch that dies mid-way has already
exported its finished cases. Shape:

- `TraceSinkService.exportStream(tenant, ctx, attach?)` → `{push, settle}` — setup (sink roster →
  per-harness selection → secret resolve → `buildTraceSink`) happens **once at stream creation**; `push`
  fires a bounded per-case `sink.export(ctx, [case])` (default concurrency 2 — sink rate-limit guard);
  `settle` joins and aggregates into the **same `ScorecardRecord.export` shape** (status/url/per-case ids —
  no schema or web change). Export tasks never throw (unchanged isolation contract); a wholesale failure
  surfaces as the first case error promoted to the top-level message. `exportScorecard` (ingest + fallback)
  is reimplemented as push-all + settle over the same core.
- **Chaining**: `JudgeStream.push` now returns a per-case completion promise; `ScorecardService.track`
  chains `judged.then(() => exportStream.push(case))` — exports always carry judge scores, and the
  case-completion pipeline is now executed → judged → exported with only aggregate/persist as the barrier.
  Wired via `ScorecardServiceDeps.exportStreamFor`; without it the live batch falls back to the old
  post-batch `exportResults` (no regression), and ingest stays batch-shaped.
- **Supersede**: no new exports are launched after abort; already-launched ones are joined and recorded as a
  partial `export` outcome on the superseded record (traceability — `superseded ≠ succeeded`, no pollution).

## Follow-ups (deliberately not in this pass)
- **Durable batch orchestration on Temporal** — per-case activities give restart resilience + horizontal
  control-plane scale; extend the existing runs pattern when batch sizes demand it.
- **Capacity-derived dispatch concurrency** — `runSuite` default 4 is static; derive from
  `Scheduler.capacity()` when large clusters go underutilized.

## Non-goals

- Force-killing in-flight backend jobs on supersede (separate problem, tracked in github-actions-trigger).
- Parallelism *within* a case's judges (usually 1–2 judges; case axis dominates).
- Changing where judges run (control-plane co-locate via `placement` stays as designed in
  judge-placement-locality).
