# Work queue — workload visibility (running/queued/next-scheduled per runtime lane)

Schedule firings, a user's scorecard runs, and one-off runs are all **workloads** received by the
control plane and queued/dispatched. This document is the SSOT for the read-only visibility slice that
surfaces that queue in a single view.

## Questions → answers
- **What's the current work-queue state?** — all scorecard batches + standalone runs in `queued`/`running` state.
- **Which runtime is it scheduled on?** — lanes are classified by the `runtime` (placement.target) axis captured on the record.
- **What's running on each runtime right now?** — the lane's `running[]` (batches include progress).
- **What's next?** — the front of the lane's `queued[]` FIFO + the next firing of active schedules (`upcoming[]`).

## Data (mig `0040`, additive)
- `RunRecord.runtime` / `ScorecardRecord.runtime` — stamps the runtime the workload was placed on at submit time
  (`RunService.submit`: explicit runtime ?? case placement.target; `ScorecardService.submit`: input.runtime;
  a batch's child runs get the same value). **NULL = default backend** or a legacy record. Lightweight → included in `list`.
- Lane keys: `''` (default backend) · registered runtime id · `self:<runnerId>` (self-hosted).
  Registered runtimes **expose empty lanes too** ("this runtime is idle" is information).

## Unit (design decision — user-confirmed)
**A batch (scorecard) = 1 job**: case fan-out (child runs) is not expanded into items but collapsed into the batch's
**progress** (`progress { done, active, total? }`) — done/active are child-run counts,
total is the dataset case count (omitted if it can't be resolved). A standalone run stays 1 job.

## Two queues (scope separation — user-confirmed)
The **workspace queue** and the **personal queue are different queues.** workspace = work requested in the workspace
that runs on **shared runtimes** (default backend `''` + registered infra) — `self:*` items never appear here.
personal = the requester's **own** self-hosted runner (`self:<runnerId>`) queue (lane label = runner hostname).
Other members' personal runner queues are not exposed (same as the runner ownership model) and are excluded from totals aggregation.

## Service/transport (BFF↔MCP parity)
`QueueService.snapshot(tenant, subject?)` (`apps/api/src/queue-service.ts`) — assembles `{ workspace: lanes[],
personal: lanes[] }` from store listings (lightweight) alone (personal scope determined by `myRunners(subject)`):
the active states of scorecards + runs (standalone) + `ScheduleService.list`'s `nextFireTimes` (Temporal
authoritative; if absent, upcoming is omitted — cron approximation is the web schedule screen's domain) + `RuntimeRegistry.list`.
- HTTP: `GET /queue` (`runs:read`, viewer+)
- MCP: `get_queue` (same gate)

**Time series (`GET /metrics`)** — the Prometheus half (the snapshot above answers "now"; this answers
"since when / how often / how long"). Zero-dep text exposition: scrape-time gauges (queue depth, per-backend
in-flight + memory, per-workspace in-flight/queued, open circuits) + counters at the dispatch seam
(`everdict_dispatch_total{runtime,outcome}`, spillovers, breaker open transitions, speculation fired/won, OOM
escalations) + a per-runtime case-duration histogram. UNAUTHENTICATED by design (standard scrape practice —
firewall the path in deployments). Live: one dead+kind shard batch registered breaker_open 1, spillover_total 3,
dispatch infra 3 / ok 6, duration count 6 in a single scrape. Every dispatch (runs, batch cases, judges) flows
through one metered dispatcher wrapper, so coverage needs no per-caller wiring.

**Scheduler observability** (the seeing half of the fairness/envelope machinery — docs/execution-backends.md):
the snapshot carries a workspace `scheduler` slice (`{queued, inFlight, quota?}` — THIS tenant's numbers only)
and each workspace lane an `admission` view (`{inFlight, memInFlightMb?, memoryBudgetMb?, maxConcurrent?,
circuit?}`). Lane mapping: a tenant runtime's backends `rt:<tenant>:<id>@<ver>` sum into the id's lane (another
tenant's same-id runtime never counts — filtered inside the service); bare-named global env backends aggregate
into the `''` (default) lane; self-hosted lanes are lease queues → no admission. `circuit` is the spillover
breaker state (open = dispatches currently route around this runtime). The web lane header shows the memory
envelope (`used/budget Mb`) and an open-circuit badge; live-verified: an autoscaled batch showed
`queued 4 / inFlight 8` + `memInFlightMb 4096`, and a dead-runtime shard surfaced `circuit {open, consecutive 3}`.

## Web (`/{workspace}/queue`, nav 'Work')
`widgets/queue-board` — two groups: **workspace queue / my personal queue (self-hosted)**. Each lane card
(Server/Laptop icon + label + count, idle badge) has 3 columns in **flow direction**:
**next-scheduled ⇢ queued (FIFO, a 'next' badge at the front) ⇢ running (progress bar)** — pulse connectors between
columns give a left→right rushing-current feel. Items are fixed-spec rows (52px): EntityRef kind icon +
executor avatar + timestamp. If there's active work, `AutoRefresh` (5s); if everything is idle, no polling.

## Correctness: orphan recovery on boot
Batches/runs are tracked in-process inside the control-plane process (single-process assumption) — on restart, the
previous process's in-flight records become ghosts with no owner to take them over, and the queue shows 'running'
forever. On boot, `recoverInterrupted` (`startup-recovery.ts`) finalizes queued/running batches, children, and
standalone runs as **failed(INTERRUPTED)**. If two control planes share the same DB, another's in-flight records
will also be recovered, so keep the single-control-plane assumption.

## Limitations / follow-ups
- Queue order is a createdAt FIFO **approximation** — the actual dispatch order is decided by the Scheduler
  (WFQ)/runner lease and may be reordered for tenant fairness. Exposing the measured self-hosted lease-queue depth is a follow-up.
- Queue control (writes) like cancel/reorder is outside this slice (read-only).
- upcoming is only present when a Temporal driver exists (nextFireTimes). dev (no driver) has an empty column.
