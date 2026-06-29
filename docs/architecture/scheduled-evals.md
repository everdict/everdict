# Scheduled evals — run a scorecard on a cron schedule (regression monitoring)

> **Status: PROPOSED (design — not yet implemented).** Driver decision **locked with the user: Temporal
> Schedules (native)**.
>
> Like [self-hosted-runner](./self-hosted-runner.md) and [judge-placement-locality](./judge-placement-locality.md):
> **strict generalization, additive.** The unit of work — `ScorecardService.submit(RunScorecardInput)` — is
> reused **verbatim**. A schedule is just a *stored* `RunScorecardInput` + a cron spec + a policy. The existing
> `POST /scorecards` path is untouched; the absence of a schedule changes nothing.

## Problem

Teams want **"run dataset × harness every night and tell me if it regressed."** Today every scorecard is a
manual `POST /scorecards`; there is no recurring trigger and no automatic baseline-vs-latest comparison over
time.

The payoff is nearly free: `trendSeries` (regression-over-time) and `diffScorecards` (baseline↔candidate) plus
`onComplete` (Mattermost) **already exist**. A cron trigger that re-submits the same run nightly turns those into
automated regression monitoring with near-zero new analytics code.

## Current state — verified

- **Trigger is one call** — `ScorecardService.submit(RunScorecardInput)` (`apps/api/src/scorecard-service.ts`)
  → `queued` record → async batch via the in-process **`dispatcher`** (Scheduler/Router).
- **Scorecards do NOT go through Temporal today.** `scorecardService` holds a `Dispatcher` and never touches the
  `Orchestrator`. (Single runs via `RunService` *can* use the Orchestrator; scorecards don't.)
- **Orchestration is optional** — `DirectOrchestrator` (in-process, the `--orchestrator direct` default) vs
  `TemporalOrchestrator` (durable). The worker (`assay worker` → `runWorker`) holds a `Scheduler` + activities
  (`dispatchCase`); it does **not** hold a `ScorecardService`.
- **Regression analytics already shipped** — `summarizeScorecard` / `diffScorecards` / `trendSeries`
  (`@assay/suite`); `onComplete` notifies (Mattermost). Records are workspace-scoped in `ScorecardStore`.
- **Auth** — `Principal.via ∈ {oidc, api-key, runner}`; `/internal/**` routes are guarded by `x-internal-token`
  (constant-time, fail-closed) — e.g. `POST /internal/tenant-keys`.
- **`concurrency` (just shipped)** — `RunScorecardInput.concurrency` flows to `runSuite`; a scheduled run carries
  it like any other.

## Design

### The schedule is data; the trigger is reuse

A **`Schedule`** = a stored `RunScorecardInput` + `{ cron, timezone, overlapPolicy, enabled }` + provenance
(`createdBy`, `lastFiredAt`, `lastStatus`). SSOT = a new **mutable** `ScheduleStore` (`@assay/db`; `InMemory` +
`Pg` + numbered migration), workspace-scoped. It is mutable (pause/resume/edit) → a **Store**, not the immutable
versioned registry. **No new execution engine** — firing = calling the existing `submit`.

### Driver: Temporal Schedules (native) — chosen

Temporal **Schedules** give timezone, overlap policy, catchup window, pause/resume and backfill **natively** —
exactly the hard parts of cron. Our DB `Schedule` is the **SSOT for the UI/API**; the Temporal Schedule is the
**execution mechanism**. `ScheduleService` keeps the two in sync (create/update/pause/delete write the DB **and**
call the Temporal `ScheduleClient`); reads/list come from the DB (fast, workspace-scoped). Temporal unreachable
at mutate time ⇒ **fail the request** (Temporal-native ⇒ Temporal required).

```
ScheduleClient.create({
  spec:    { cronExpressions: [cron], timeZone },
  policies:{ overlap: overlapPolicy },
  action:  startWorkflow scheduledScorecardWorkflow(scheduleId, tenant)
})
      │  (Temporal fires per cron)
      ▼
scheduledScorecardWorkflow(scheduleId)            [deterministic — NO I/O]
  1. id = await submitScheduledScorecard(scheduleId)   // activity → API internal route → ScorecardService.submit
  2. await pollUntilTerminal(id)                        // activity getScorecardStatus + workflow.sleep loop
  3. await notifyRegression(scheduleId, id)             // activity: diff vs previous scheduled run → Mattermost
```

**Why the workflow polls to completion (step 2):** `submit` returns a `queued` record immediately. If the
workflow fired-and-returned, Temporal would never see the real (minutes-to-hours) run as "still running", so
`Skip`/`BufferOne` overlap would be a no-op. Polling to terminal makes the workflow's lifetime track the actual
scorecard, so **overlap and timeouts behave as intended**.

### Bridging "scorecards bypass Temporal" (the key wrinkle)

The worker holds only a `Scheduler`, not a `ScorecardService`. So the schedule activity reaches `submit` via a
new **internal route** `POST /internal/schedules/:id/fire` (`x-internal-token` guard, like
`/internal/tenant-keys`) that loads the `Schedule` and calls
`ScorecardService.submit({ ...schedule.runInput, tenant: schedule.tenant, submittedBy: schedule.createdBy })`;
`GET /internal/schedules/:id/last-status` backs the poll. The worker stays thin and `ScorecardService` stays the
single owner in the API — **no fork, no stores duplicated into the worker**. (Alternative — co-host a
`ScorecardService` in the worker — rejected: it would need every store/registry the API wires.)

### The Assay-specific decisions

- **Identity** — a fire has no live user token. The schedule stores `createdBy` (subject); the run executes as
  that subject: budget → `tenant` (workspace), private-repo case tokens resolve against the **creator's**
  personal connections (`repoTokenFor(createdBy, connectionId)`) — identical to a manual submit. **If the creator
  leaves the workspace or revokes the connection, private-repo fires break** → policy: **auto-disable** the
  schedule and surface the reason (`lastStatus`/last-fire error on the record). A new `via:"schedule"` is **not**
  needed — the internal route is token-guarded and passes `tenant` + `submittedBy` explicitly.
- **Self-hosted runtime** — `runtime=self:<id>` requires the runner be **online at fire time**, else jobs park
  then `queueTimeoutMs`-reject. Warn in the UI; treat a no-runner fire as a failed run with a clear reason (don't
  retry forever).
- **Overlap** — default **Skip** (don't pile up long evals); expose `BufferOne`/`AllowAll`
  (Temporal `ScheduleOverlapPolicy`).
- **Version** — `harness.version=latest` (default) ⇒ each fire re-resolves latest (the point of regression
  monitoring); pin for a fixed-version cadence.
- **`concurrency`** — carried in `runInput`; scheduled runs are case-parallel like manual ones.

### Surface (BFF↔MCP parity + roles)

- **HTTP** — `POST /schedules` `{name, cron, timezone?, dataset, harness, judges?, metrics?, runtime?,
  concurrency?, overlapPolicy?, enabled?}` → record; `GET /schedules`, `GET /schedules/:id`,
  `PATCH /schedules/:id` (edit / pause / resume), `DELETE /schedules/:id`, `GET /schedules/:id/runs` (scorecards
  this schedule produced, tagged `{scheduleId, firedAt}`).
- **MCP** — `create/list/get/update/delete_schedule` (same `ScheduleService` core).
- **Internal** — `POST /internal/schedules/:id/fire`, `GET /internal/schedules/:id/last-status` (`x-internal-token`).
- **Roles** — new `schedules:read` (viewer+) / `schedules:write` (member+) in the authz matrix; gate mutating
  routes + workspace-scope; another workspace's schedule reads **404**.
- **Web** — a Schedules page (list + enable toggle + next/last fire + last verdict) and a **"이 설정으로 예약"**
  button on the scorecard run form (reuse the form values → `POST /schedules`). Cron picker (presets 매일/매주/매시
  + raw expression).

### Reuse vs new

| Piece | Status |
|---|---|
| `ScorecardService.submit` / `RunScorecardInput` / `trendSeries` / `diffScorecards` / `onComplete` | **reused verbatim** |
| Temporal client/worker, `/internal` token guard, `ScorecardStore`, registries | **reused** |
| `ScheduleStore` (`@assay/db`) + migration | **new** |
| `ScheduleService` + `ScheduleDriver` (`TemporalScheduleDriver`) | **new** |
| `scheduledScorecardWorkflow` + activities (submit / status / notify) | **new** (`@assay/orchestrator`) |
| `/schedules` routes + MCP tools + `schedules:*` authz | **new** (`apps/api`) |
| Schedules web page + "예약" button | **new** (`apps/web`) |

## Slices (pnpm gates green at each)

1. **Schedule SSOT** — `ScheduleStore` (`InMemory` + `Pg` + mig), Zod schema + cron validation; `ScheduleService`
   CRUD (DB only, no firing yet); `/schedules` routes + MCP parity + `schedules:*` roles; web list/create.
   *(Fully testable with no Temporal.)*
2. **Temporal driver** — `TemporalScheduleDriver` (`ScheduleClient` create/update/pause/delete), `ScheduleService`
   syncs DB↔Temporal; `scheduledScorecardWorkflow` + submit/status activities + `/internal` fire/status routes.
   Fires a real scorecard on cron.
3. **Regression alert + UX** — `notifyRegression` activity (diff vs the previous scheduled run → Mattermost),
   `lastStatus`/verdict on the record; web cron picker + next/last-fire + pause toggle; creator-left /
   connection-revoked auto-disable policy.

## Decisions / non-goals

- **Temporal required for firing (chosen).** The Direct/in-memory dev path won't fire schedules (CRUD still
  works; they just don't run). A dev-only ticker is explicitly **out of scope** (revisit only if dev demand
  appears).
- **No new durable eval execution.** Schedules trigger the existing in-process batch; the workflow only wraps
  fire + poll for cron semantics. Making each case a durable workflow is a separate concern (`evalCaseWorkflow`).
- **One run template per schedule.** A matrix (N datasets × M harnesses) = N×M schedules, not a new combinatorial type.
- **Backfill** is available via Temporal but not surfaced in v1 (manual "run now" covers the common need).

## See also

[scorecards.md](../scorecards.md) · [orchestration.md](../orchestration.md) · [suites.md](../suites.md)
(trend/diff) · [connections.md](../connections.md) (private-repo token lifecycle) ·
[self-hosted-runner.md](./self-hosted-runner.md) (runtime online-ness) · rules `orchestrator` / `api-layer` / `auth`.
