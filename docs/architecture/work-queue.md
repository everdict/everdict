---
kind: wiki
title: "Work queue — workload visibility (running/queued/next-scheduled per runtime lane)"
status: current
updated: 2026-09-15
anchors: [packages/application-control/src/queue/queue-service.ts, apps/api/src/api/queue/queue.routes.ts, apps/api/src/api/queue/queue.mcp.ts, apps/web/src/widgets/infra-panel/ui/work-tab.tsx]
---
# Work queue — workload visibility (running/queued/next-scheduled per runtime lane)

Schedule fires, scorecard runs and one-off runs are all **workloads** the control plane receives, queues and
dispatches. This page describes the view that shows that queue in one place, plus the two controls it offers
over the scheduler's real queue.

## Questions → answers
- **What's the current work-queue state?** — all scorecard batches + standalone runs in `queued`/`running` state.
- **Which runtime is it scheduled on?** — lanes are keyed by the `runtime` (placement.target) captured on the record.
- **What's running on each runtime right now?** — the lane's `running[]`; batches include progress.
- **What's next?** — the front of the lane's `queued[]` plus the next fire of active schedules (`upcoming[]`).

## Data (mig `0040`, additive)
- `RunRecord.runtime` / `ScorecardRecord.runtime` — the runtime the workload was placed on at submit
  (`RunService.submit`: explicit runtime ?? case placement.target; `ScorecardService.submit`: input.runtime;
  a batch's child runs get the same value, rewritten to the runtime that actually ran the case after a
  spillover). **NULL = default backend** or a legacy record.
- Lane keys: `''` (default backend) · registered runtime id · `self:<runnerId>` (self-hosted).
  Registered runtimes **also show up as empty lanes** — "this runtime is idle" is information.

## Unit
**A batch (scorecard) = 1 job.** Its fan-out (child runs) is folded into the batch's
`progress { done, active, waiting, total? }`: `done` = finished children (succeeded + failed), `active` =
running children, `waiting` = queued children (parked behind a runner or backend slot), `total` = the
selected subset size, else the dataset case count (omitted when it cannot be resolved). A standalone run is 1 job.

## Two queues
The **workspace queue** and the **personal queue** are separate. The workspace queue is work requested in the
workspace that runs on **shared runtimes** (default backend `''` + registered runtimes); `self:*` items never
appear there. The personal queue is the requester's **own** self-hosted runners (`self:<runnerId>`, lane label =
runner hostname). Other members' personal runner queues are not shown and are left out of the totals.

## Service and transport
`QueueService.snapshot(tenant, subject?)` builds `{ totals, scheduler?, workspace: lanes[], personal: lanes[] }`
from lightweight store listings: active scorecards + standalone runs, child counts per running batch
(`RunStore.countChildrenByStatus`), `ScheduleService.list`'s `nextFireTimes`, `RuntimeRegistry.list`, and the
requester's runners (`myRunners(subject)`).
- HTTP: `GET /queue` (`runs:read`, viewer+)
- MCP: `get_queue` (same gate)

**Scheduler observability.** When the live `Scheduler` is injected, the snapshot carries a workspace
`scheduler` slice — `{queued, inFlight, quota?, entries?}`, THIS tenant's numbers only, `quota` from
`EVERDICT_TENANT_QUOTAS` — and each workspace lane an `admission` view
(`{inFlight, memInFlightMb?, memoryBudgetMb?, cpuInFlight?, cpuBudget?, maxConcurrent?, circuit?}`). Lane
mapping: a tenant runtime's backends `rt:<tenant>:<id>@<ver>` sum into the id's lane (another tenant's runtime
with the same id is filtered out inside the service); bare-named global backends aggregate into the `''` lane;
self-hosted lanes are lease queues and have no admission view. `circuit` is the spillover breaker state (open =
dispatches currently route around this runtime).

The time-series half (`GET /metrics`, Prometheus text) is operator-only and fail-closed: it answers 404
without `EVERDICT_METRICS_TOKEN` and 403 without the matching bearer token — see
[metrics-commercialization.md](./metrics-commercialization.md).

## The scheduler's real queue (entries + controls)

The lanes are a **projection of record status** (records grouped by runtime). The control plane's actual
dispatch queue is the `Scheduler`'s WFQ, surfaced as `snapshot.scheduler.entries`: this workspace's waiting
entries in the order the scheduler's pump will try them. Urgent entries come first — interactive,
operator-promoted, or waiting longer than `agingMs` — then the rest, tenant-fair within each class; position 1
is next. Each entry carries its identity (`caseId` / `runId` / `batchId` / harness / pinned `target` /
`priority` / `tags` — `["judge"]` marks a control-plane judge job), `enqueuedAt` / `waitedMs` / `urgent` /
`promoted`, and a stable handle `id` (`q<seq>`).

Two controls, both gated `runs:submit` (the same gate as submitting work). `QueueService` enforces the tenant:
an entry from another workspace, or one already placed, reads 404, so existence does not leak.
- `DELETE /queue/entries/:entryId` (MCP `cancel_queued_job`) — `Scheduler.cancelEntry` removes the WAITING entry,
  releases its budget reservation and permit, and rejects its dispatch with `CANCELLED`. In-flight work is untouched.
- `POST /queue/entries/:entryId/promote` (MCP `promote_queued_job`) — `Scheduler.promoteEntry` moves it to the
  front of the effective order: urgent class plus the fair-queue head (`FairQueue.promote`). Fairness
  bookkeeping is untouched. To reorder the whole queue, promote entries in reverse of the order you want.

`CANCELLED` is never classified retryable (`classifyFailure`), so a batch case whose entry is cancelled settles
as a failed case rather than being re-dispatched by the batch's retry loop. Cancelling the scorecard is still
how a whole batch is stopped.

## Web — the work tab of the infra panel (`apps/web/src/widgets/infra-panel`)
Not a nav page: it is the **work tab of the floating infra panel**, opened from the vertical rail on the right
edge. The rail's work button carries the running + queued badge. The tab has two groups: **workspace queue** and
**my personal queue (self-hosted)**. Each lane card (Server/Laptop icon, label, counts, admission bar with
memory/cpu envelope and an open-circuit badge; idle lanes collapsed) renders the flow **upcoming ⇢ queued (FIFO,
a 'next' badge on the front) ⇢ running (progress bar)**. A running run opens in the panel's runs tab; a
scorecard navigates the main view. The scheduler entries render under the scheduler headline with wait time,
badges, and per-row promote/cancel actions (re-polled right after a mutation).
Polling (`infra-panel-context.tsx`): 4 s while the panel is open, 20 s while closed (badge only), skipped
while the browser tab is hidden.

## What the view cannot tell you
- Lane queue order is a createdAt FIFO **approximation**; the authoritative order is `scheduler.entries`
  (managed lanes only).
- `upcoming` exists only when a Temporal schedule driver supplies `nextFireTimes`; without one the column is empty.
- Records that a dead control plane left `queued`/`running` stay in the lanes until boot recovery resumes or
  tombstones them — see [batch-resilience.md](./batch-resilience.md) and
  [multi-replica.md](./multi-replica.md) for which replica reclaims what.
