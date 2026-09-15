---
kind: wiki
title: "Judge runtime selection + store-locality placement + pluggable observation delivery"
status: current
updated: 2026-09-15
anchors: [apps/api/src/core/execution/judge-runner.ts, packages/contracts/src/harness/judge-spec.ts, packages/topology/src/front-door/observation-source.ts]
---
# Judge runtime selection + store-locality placement + pluggable observation delivery

Where a dispatched judge runs, and how the observation it scores reaches it. The user-facing field references
are `docs/judges.md` (judge `runtime`) and `docs/service-harness.md` (`target.delivery`); this page records why
the two are one design and what was deliberately not built.

## The idea

*Don't ship a big observation to a far judge.* Either put the judge next to the store and fetch by
**reference**, have the run **return** the observation inline (**sentinel**), have the run **push** it somewhere
the platform can read (**egress**), or recover it from the harness's own artifact store through the trace
(**trace**). Delivery mode (how the observation travels) and locality (where the judge sits) are two halves of
the same decision. Every field is optional and its absence behaves as before: default backend, `reference`.

## D1 — judge runtime selection

`HarnessJudgeSpec.runtime?` and `CodeJudgeSpec.runtime?` (`packages/contracts/src/harness/judge-spec.ts`) name a
tenant runtime; the judge runner (`apps/api/src/core/execution/judge-runner.ts`) sets it as the judge job's
`placement.target`, so the judge rides the same `runtime → placement.target → RuntimeDispatcher` path as any run.
No new dispatch path and no `Placement`/`Scheduler`/`CaseJob` schema change. An unregistered runtime is not
refused at registration (matching the scorecard selector): the dispatch fails and the judge records a visible
skip. Model judges call their provider in-process and have no `runtime`. The web judge form offers the
workspace's runtimes (`apps/web/src/features/register-judge`).

## D2 — store-locality by co-location

With no explicit `runtime`, a dispatched judge **inherits the placement of the run that produced the
observation**: `ScoringService` (`packages/application-control/src/execution/scoring-service.ts`) reconstructs
the producing run's placement (the batch's selected runtime over the case's own placement) and passes it to
`JudgeRunner.run`; the runner uses `spec.runtime ?? inherited`. The placement is rebuilt from the run, not read
back off the judge's `ctx.case`, because the dataset case does not carry the runtime a batch placed it on. Trace
ingest has no producing run, so a judge there falls back to `runtime` or the default backend. A co-located
`self:<runnerId>` placement also needs the producing run's submitter, which the runner carries.

## D3 — pluggable observation delivery

`TopologyTarget.delivery?` (`ObservationDeliverySchema`, `packages/contracts/src/harness/harness-spec.ts`)
selects an `ObservationSource` (`packages/topology/src/front-door/observation-source.ts`) — the HOW-observe
sibling of `TopologyRuntime` (where) and `FrontDoorDriver` (how to drive). `service-backend.ts` calls
`observationSourceFor(...)` for every case:

| mode | who moves the observation | snapshot source |
| --- | --- | --- |
| `reference` (default) | the platform pulls | the provisioned target's `snapshot()`; with no target, a prompt snapshot carrying the result-channel body |
| `sentinel` | the run returns it inline | the front-door completion body (`DriveOutcome.response`), at `path?` (absent = whole body) |
| `egress` | the run pushes it to a sink | a GET of the `{run_id}`-interpolated `sink` URL |
| `trace` | the harness offloads it to its own store and references it from the trace | the trace source's resolved evidence, synthesized into a browser snapshot |

Every non-reference body is validated as an `EnvSnapshot`; a malformed one fails the run explicitly rather than
falling back.

## Non-goals

- **No affinity-scoring scheduler.** Locality is co-location by inheritance, not a `PlacementPolicy` that scores
  candidates by store distance. The `Scheduler` (`packages/backends/src/scheduling/scheduler.ts`) places by
  capacity, tenant fairness and hard `placement.target` pins, and no runtime or store carries a locality tag. If
  cross-runtime placement (judge in cluster A, store in cluster B) becomes a real case, that needs explicit
  runtime/store locality tags.
- **No model-judge runtime.** Model judges call a provider in-process.
