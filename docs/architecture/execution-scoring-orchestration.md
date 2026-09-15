---
kind: wiki
title: "Execution · Orchestration · Scoring — the three concerns"
status: current
updated: 2026-09-15
anchors: [packages/application-control/src/execution/execute-case.ts, packages/application-control/src/scorecard/batch-driver-shared.ts, packages/application-control/src/scorecard/resilient-case-runner.ts]
---
# Execution · Orchestration · Scoring — the three concerns

The control plane keeps three concerns apart. Successor to [run-as-primitive](https://github.com/everdict/everdict/blob/a958dc36d772615a1de0dc81f59f4bb2f4b366d7/docs/architecture/run-as-primitive.md) (removed; pinned), which made
`run` the execution primitive and `scorecard = run × N`; this page is how the pieces that drive a run, score it
and deliver it stay separate.

| Concern | Essence | Owner (`packages/application-control/src/`) |
|---|---|---|
| **Execution** | run one case → a `CaseResult`. Nothing after. | `execution/execute-case.ts` `executeCase(deps, owner, job, opts?)` |
| **Scoring** | over results/traces: resolve judges · apply them · collect judge models | `execution/scoring-service.ts` `ScoringService` (aggregation stays pure in `@everdict/domain`) |
| **Orchestration** | admit · fan out · settle budget · offload · persist · deliver · progress | `run/run-service.ts` `RunService` (single) · `scorecard/` batch collaborators |

## Principles

1. **`executeCase` is pure execution.** Promote a command harness's image onto the case, resolve private-repo
   and registry credentials, dispatch, and complete a job-deferred trace collection (`traceRef` —
   [streaming-case-pipeline](./streaming-case-pipeline.md) D4). It does not admit or settle budget, offload,
   notify, call back, judge, or aggregate.
2. **Scoring is a function over results**, independent of how they were produced. One `ScoringService` serves
   live batches **and** ingest.
3. **The orchestrator drives.** Admission, concurrency, fan-out, budget settle, persistence and delivery all live
   in the orchestrators, wrapping pure execution and pure scoring.
4. **A scorecard is a scoring artifact over a set of runs**, not a second execution object.

## Where each concern lives

- **Single run** — `RunService.submit` admits (`budget.admit`, 402) and creates the record; its private `track`
  calls `executeCase`, settles the budget from the trace's cost lines, offloads the snapshot, settles the run,
  and fires `onComplete`. The run webhook is no longer posted inline: delivery hangs off the terminal fact
  (`platform-event/run-webhook-consumer.ts`), and completion notifications ride the event log
  (`notification/notification-service.ts`).
- **Batch** — `ScorecardService` is a facade over collaborators in `scorecard/`. `ScorecardBatchService` builds
  one `BatchDriverShared` bag and hands it to both drivers: `InProcessBatchDriver` (one instance per batch, the
  fan-out loop in this process) and `WorkflowBatchDriver` (the Temporal bridge —
  [temporal-batch-orchestration](./temporal-batch-orchestration.md)). Both reach execution only through
  `ResilientCaseRunner` → `executeCase`, end a case through `CaseOutcomeCommitter`, and score through the shared
  `ScoringService`. Two drivers exist because the loop's bookkeeping is per batch, not to add a layer over
  `executeCase`.
- **Ingest** — `ScorecardIngestService` (`POST /scorecards/ingest`, `POST /scorecards/ingest/pull`) scores
  externally produced traces through the same `ScoringService` and dispatches no harness run. It is the
  existence proof that scoring does not need the execution path.
- **In-sandbox execution** is a different layer: `runCase` (`@everdict/application-execution`) drives the harness
  under test through a Driver inside the isolated job. Nothing on this page touches it.

## Sanctioned service→service seams

Peer resource services never call each other (rule `api-layer`); the named exceptions are registered here:

- **Orchestration → `executeCase` / `ScoringService`** — the decomposition above.
- **`JudgePreviewService` → `RunService.submit`** (via `codeJudgeRunSubmitter`, `apps/api/src/composition/run.ts`) —
  the **code-judge dry-run promotion**: `POST /judges/try` on a `kind:"code"` judge submits the sandboxed wrapper
  job as a real standalone run (`trigger: "judge-preview"`, inline `harnessSpec`) and returns `{ runId }`, so
  progress/logs/verdict ride the run surfaces instead of an invisible blocking dispatch. This is single-run
  *delivery* by design (one interactive dry-run, a person watching) — exactly what `RunService.submit` owns, so
  the batch prohibition below does not apply. See `docs/judges.md` §Dry-run.

## Invariants / non-goals

- **Do NOT route the batch through `RunService.submit`.** That bundles single-run *delivery* (202/webhook/per-run
  notify/submit-admit) which must not fire per case. The shared unit is `executeCase`, not the single-run
  orchestrator.
- **No `materializeRun` helper.** Each orchestrator manages its own record lifecycle (run record vs. child runs
  under a scorecard); that is not duplication of a concern.
- **Ingest stays embed-only** — it scores fetched or uploaded traces and dispatches no harness run.
