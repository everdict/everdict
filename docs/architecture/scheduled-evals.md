---
kind: wiki
title: "Scheduled evals — run a scorecard, a trace evaluation or a view report on a cron schedule"
status: current
updated: 2026-09-15
anchors: [packages/application-control/src/schedule/schedule-service.ts, apps/api/src/core/schedule/temporal-schedule-driver.ts, apps/api/src/api/schedule/request/shared.ts, packages/contracts/src/records/schedule.ts, apps/web/src/shared/lib/cron.ts]
---
# Scheduled evals — run a scorecard, a trace evaluation or a view report on a cron schedule

Teams want **"run dataset × harness every night and tell me if it regressed."** A schedule is a stored run
template plus a cron spec and a policy. Firing one reuses the ordinary entry points —
`ScorecardService.submit`, `ScorecardService.ingestPull`, or an agent report turn — so a schedule adds a
trigger, not an execution engine. With no schedules configured, nothing changes.

## The record

`ScheduleRecord` (`packages/contracts/src/records/schedule.ts`; `ScheduleStore` in `@everdict/db`, in-memory +
Pg, table from migration `0027_create_schedules`) is workspace-scoped and mutable:
`{ name, cron, timezone (IANA, default UTC), overlapPolicy (skip | bufferOne | allowAll, default skip),
enabled, runTemplate, createdBy }` plus what firing records — `lastFiredAt`, `lastScorecardId`,
`lastArtifactId`, `lastStatus`. The domain rules (defaults, 5-field cron validation, edit gate, auto-disable)
live in `@everdict/domain` `Schedule`.

`runTemplate` has exactly one of three modes (enforced by a refine):

- **Batch** — `dataset` + `harness` (+ `judges`, `runtime`, `concurrency` ≤ 64, `trials`, `cases` subset).
  Each fire calls `ScorecardService.submit`.
- **Trace evaluation** — `pull: { source, correlate?, scope?, windowHours }`. Each fire lists the source's
  trace ids in a rolling window ending at the fire moment (`listTraceIds`, at most 500) and judges them with
  `ScorecardService.ingestPull` — no harness run. The reserved source name `everdict` reads the platform's own
  trajectory store. An empty window yields an empty succeeded scorecard, so a quiet day is still recorded.
- **View report** — `report: { view, instructions?, compare? }`. Each fire snapshots the View's numbers to the
  workspace filesystem, then runs one budgeted headless agent analysis turn (`AgentReportRunner`, the agent
  service's internal route; needs `AGENT_SERVICE_URL` + `AGENT_INTERNAL_TOKEN`). It stamps `lastArtifactId`
  with `lastStatus: reported` (or `report-empty`); no scorecard is produced. See
  [analysis-studio.md](./analysis-studio.md).

## Firing — Temporal Schedules

The DB record is the source of truth for the UI and API; a Temporal Schedule is the clock. When
`EVERDICT_TEMPORAL_ADDRESS` is set, the control plane wires `TemporalScheduleDriver`
(`apps/api/src/core/schedule/temporal-schedule-driver.ts`), and `ScheduleService` keeps the two in sync:

- `create` writes the DB, then `driver.ensure` (delete-and-recreate `everdict-sched-<id>` with the cron,
  timezone, overlap policy and paused state). If Temporal rejects it, the DB row is rolled back and the
  request fails.
- `update` writes the DB, then calls `ensure`; a Temporal failure fails the request after the DB write.
- `remove` deletes the Temporal schedule first and leaves the DB row untouched if that fails.
- At boot, `ScheduleService.reconcile` deletes Temporal schedules whose record is gone, and a fire for a
  missing record also deletes its orphaned Temporal schedule.

The driver lives in `apps/api` and uses only `@temporalio/client`, so the API process never loads the
worker's native bindings. The workflow and activities live in `@everdict/orchestrator` and run in the worker:

```
Temporal Schedule everdict-sched-<id>  (cron, timezone, overlap)
      │  starts, on each tick
      ▼
scheduledScorecardWorkflow({ scheduleId, tenant })             [deterministic — no I/O]
  1. fireScheduledScorecard      → POST /internal/schedules/:id/fire              → ScheduleService.fire
     (report mode returns no scorecard id → the workflow ends here)
  2. scheduledScorecardStatus    → GET  /internal/schedules/scorecard-status/:id   (every 30 s, at most 480 polls ≈ 4 h)
  3. finalizeScheduledScorecard  → POST /internal/schedules/:id/finalize          → record the terminal lastStatus
```

- **Why the workflow polls to terminal:** `submit` returns a `queued` record immediately. A workflow that
  returned right away would make `skip`/`bufferOne` overlap meaningless; polling makes the workflow's lifetime
  match the scorecard's.
- **Why an internal route:** the worker holds no `ScorecardService`, so the activities call back into the
  control plane over HTTP with `x-internal-token` (worker env `EVERDICT_API_URL` + `EVERDICT_INTERNAL_TOKEN`).
  `ScorecardService` stays the single owner in the API; co-hosting it in the worker would need every store and
  registry the API wires.
- Every fire emits a `schedule.fired` platform event, so a time-driven agent is an ordinary subscription.
- A fired batch is an ordinary scorecard, so with Temporal configured it is itself driven by
  `scorecardBatchWorkflow` ([temporal-batch-orchestration.md](./temporal-batch-orchestration.md)).

Without `EVERDICT_TEMPORAL_ADDRESS` there is no driver: CRUD and manual "run now" work, but cron never fires.

## Identity, completion and auto-disable

- **Identity** — a fire has no live user token. It runs as the schedule's `createdBy` (`submittedBy`), with
  `origin: { source: "schedule", scheduleId }`: budget is charged to the workspace, and private-repo tokens
  resolve against the workspace GitHub App installation, exactly as for a manual submit.
- **Completion notification** — the scorecard's own `scorecard.completed` / `scorecard.failed` event becomes a
  feed row, branded `schedule_completed` / `schedule_failed` ("Scheduled run …") when the origin is a
  schedule. Cron fires and manual "run now" therefore notify exactly once. Report fires notify through
  `notifyReport`. See [notifications.md](./notifications.md).
- **Auto-disable** has two triggers, and both set `enabled: false` with the reason in `lastStatus` and pause
  the Temporal schedule:
  - **the creator leaves or is removed** — `MembershipService` calls `ScheduleService.disableByCreator`;
  - **a fire fails with a config-class error** (`classifyFailure`: deleted dataset/harness/view, revoked
    credentials or authz, invalid template, exhausted budget) — the same fire would fail the same way on
    every tick. Transient failures rethrow, and the firing activity's retry handles them.
  A deployment missing a firer (for example no report runner) answers 400 without disabling the schedule.
- **Self-hosted runtime** — `runtime=self:<id>` needs the runner online at fire time; the create form says so.

## Surface (HTTP ↔ MCP parity + roles)

| HTTP | MCP | Gate |
| --- | --- | --- |
| `POST /schedules` `{name, cron, timezone?, overlapPolicy?, enabled?, runTemplate}` | `create_schedule` | `schedules:write` (member+) |
| `GET /schedules`, `GET /schedules/:id` | `list_schedules`, `get_schedule` | `schedules:read` (viewer+) |
| `PATCH /schedules/:id` (edit / pause / resume) | `update_schedule` | `schedules:write`; content edits creator or admin |
| `DELETE /schedules/:id` | `delete_schedule` | `schedules:write` |
| `POST /schedules/:id/fire` (manual "run now", no finalize) | `fire_schedule` | `schedules:write` |

- Another workspace's schedule reads 404.
- **Content edits** (name, cron, timezone, overlap, runTemplate) are limited to the creator or a workspace
  admin, enforced in `ScheduleService.update`. A patch that touches only `enabled` (pause/resume) needs only
  member.
- **Next fires** — `list`/`get` add `nextFireTimes` (ISO[]) to enabled schedules through the driver's
  `describeMany` (Temporal `nextActionTimes`, one connection for the whole list). This is best-effort, and
  internal reads skip it. Without a driver, the web computes fires itself (`apps/web/src/shared/lib/cron.ts`,
  Intl-based, IANA-tz/DST safe) and labels them **(estimated)**.
- **Run history** — the scorecards a schedule fired are `GET /scorecards?schedule=<id>` (`origin.scheduleId`).

## Web

- **Schedules list** (`apps/web/src/features/manage-schedules`): hosted in the infra panel's schedules tab.
  A view switcher (list / by owner / calendar, `?view=` deep link) sits over shared owner · status · runtime
  filters. Rows show owner, runtime, benchmark → harness, a readable cadence (`describeCron`) and the next fire
  (authoritative or estimated), with an enable/pause toggle. An upcoming-runs timeline covers the next 7 days,
  and the month calendar marks each day's active schedules (`firesOnDate`, one chip per schedule per day).
- **Create / edit** (`apps/web/src/features/create-schedule`): mode picker, cron preset chips plus a raw
  expression, runtime picker. The edit page redirects anyone who is not the creator or an admin.
- **Detail** page: schedule settings, auto-disable reason, upcoming fires, and the run history.
- A saved View's page lists its report schedules (`apps/web/src/features/view-report-schedule`).

## Decisions and non-goals

- **Temporal required for cron firing.** A dev-only ticker is out of scope.
- **One run template per schedule.** A matrix of N datasets × M harnesses is N×M schedules.
- **Backfill** is available in Temporal but not exposed; manual "run now" covers the common need.

## See also

[scorecards.md](../scorecards.md) · [orchestration.md](../orchestration.md) · [suites.md](../suites.md)
(trend/diff) · [workspace-scoped-integrations.md](./workspace-scoped-integrations.md) (private-repo token lifecycle) ·
[self-hosted-runner.md](./self-hosted-runner.md) (runtime online-ness) · [work-queue.md](./work-queue.md)
(upcoming fires per runtime lane).
