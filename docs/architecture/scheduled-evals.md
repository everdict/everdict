# Scheduled evals — run a scorecard on a cron schedule (regression monitoring)

> **Status: slices 1 + 2 + 3 SHIPPED.** Driver decision **locked with the user: Temporal Schedules (native)**.
> Slice 1 (`f57a55b` backend + `5960009` web) = Schedule SSOT + CRUD API/MCP/web. Slice 2 (`a0ed30d`) = firing —
> `ScheduleService` driver-sync seam + `fire()` + internal routes + `scheduledScorecardWorkflow` (poll-to-terminal)
> + schedule activities (HTTP bridge) + `TemporalScheduleDriver`. Slice 3 (this change) = regression alert —
> `fire()` returns the previous run id, `finalize()` (workflow calls it post-terminal) diffs vs the previous
> scheduled run and fires `notifyRegression` (Mattermost) on a regression + records final `lastStatus`; web cron
> preset picker + last-fire display. **creator-left auto-disable** also shipped (member leave/remove → disable that
> creator's schedules + Temporal pause).
>
> **Live Temporal e2e — VERIFIED (2026-07-03).** The full cron→fire→run→grade loop was run against a real
> Temporal dev server (`docker run temporalio/temporal server start-dev`) with the **codex+pinch** harness (the
> bundle harness that runs PinchBench). Two live scripts:
> `scripts/live/scheduled-pinch-temporal.mjs` (in-memory / no-auth) and `scripts/live/scheduled-pinch-acme-temporal.mjs`
> (**multi-tenant**: real Postgres + Keycloak OIDC, schedule created *as user `alice`* in workspace `acme`).
> Observed: `POST /schedules` → `TemporalScheduleDriver.ensure` created `everdict-sched-<id>`
> (`temporal schedule describe`: workflow=`scheduledScorecardWorkflow`, tq=`everdict-eval`, cron `* * * * *`,
> overlap=Skip, args carry `{scheduleId, tenant}`); Temporal fired **exactly at the top-of-minute**
> (`lastFiredAt=…:00Z`) → workflow → internal `fire` → `ScorecardService.submit` → self-hosted runner ran
> `codex exec` → `tests_pass` PASS → leaderboard row; schedule record stamped `lastFiredAt`/`lastScorecardId`, and
> the workflow's poll-to-terminal `finalize` recorded the terminal `lastStatus`. **Remaining: connection-revoked
> auto-disable (indirect: schedule→dataset→case.connectionId).**
>
> **Driver location (deviation from the table below):** `TemporalScheduleDriver` lives in **`apps/api`**
> (`temporal-schedule-driver.ts`), not `@everdict/orchestrator` — it needs only `@temporalio/client`, and importing
> the orchestrator index into the API would pull in `@temporalio/worker`'s native bindings. The
> **workflow + activities** stay in `@everdict/orchestrator` (they run in the worker). Driver is **env-gated**:
> `EVERDICT_TEMPORAL_ADDRESS` set on the API ⇒ schedules sync to Temporal and fire; unset ⇒ CRUD-only (dev). The
> worker bridges back to the API via `EVERDICT_API_URL` + `EVERDICT_INTERNAL_TOKEN`.
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
  `TemporalOrchestrator` (durable). The worker (`everdict worker` → `runWorker`) holds a `Scheduler` + activities
  (`dispatchCase`); it does **not** hold a `ScorecardService`.
- **Regression analytics already shipped** — `summarizeScorecard` / `diffScorecards` / `trendSeries`
  (`@everdict/suite`); `onComplete` notifies (Mattermost). Records are workspace-scoped in `ScorecardStore`.
- **Auth** — `Principal.via ∈ {oidc, api-key, runner}`; `/internal/**` routes are guarded by `x-internal-token`
  (constant-time, fail-closed) — e.g. `POST /internal/tenant-keys`.
- **`concurrency` (just shipped)** — `RunScorecardInput.concurrency` flows to `runSuite`; a scheduled run carries
  it like any other.

## Design

### The schedule is data; the trigger is reuse

A **`Schedule`** = a stored `RunScorecardInput` + `{ cron, timezone, overlapPolicy, enabled }` + provenance
(`createdBy`, `lastFiredAt`, `lastStatus`). SSOT = a new **mutable** `ScheduleStore` (`@everdict/db`; `InMemory` +
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

### The Everdict-specific decisions

- **Identity** — a fire has no live user token. The schedule stores `createdBy` (subject); the run executes as
  that subject: budget → `tenant` (workspace), private-repo case tokens resolve against the **workspace GitHub
  App** installation (`installationTokenFor(tenant, gitUrl)`) — identical to a manual submit. **If the creator
  leaves the workspace, fires carrying their identity break** → policy: **auto-disable** the
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

- **HTTP** — `POST /schedules` `{name, cron, timezone?, dataset, harness, judges?, runtime?,
  concurrency?, overlapPolicy?, enabled?}` → record; `GET /schedules`, `GET /schedules/:id`,
  `PATCH /schedules/:id` (edit / pause / resume), `DELETE /schedules/:id`, `GET /schedules/:id/runs` (scorecards
  this schedule produced, tagged `{scheduleId, firedAt}`).
- **MCP** — `create/list/get/update/delete_schedule` (same `ScheduleService` core).
- **Next-fire (authoritative + fallback)** — `list`/`get` enrich each **enabled** schedule with
  `nextFireTimes` (ISO[]) via the driver's optional `describeMany(ids)` (`TemporalScheduleDriver` →
  `handle.describe().info.nextActionTimes`, one connection for the whole list; best-effort — failure/absence just
  omits the field). Non-persisted, attached at read time; internal reads (`update`/`remove`/`fire`/`finalize`)
  use a private `getRecord` that skips the Temporal round-trip. When Temporal is not deployed (no driver) the web
  falls back to a dependency-free cron computation (`apps/web/.../shared/lib/cron.ts`, Intl-based, IANA-tz/DST
  safe) and marks those rows **(estimated)**.
- **Internal** — `POST /internal/schedules/:id/fire`, `GET /internal/schedules/:id/last-status` (`x-internal-token`).
- **Roles** — new `schedules:read` (viewer+) / `schedules:write` (member+) in the authz matrix; gate mutating
  routes + workspace-scope; another workspace's schedule reads **404**. **Content edit** (name/cron/timezone/
  overlap/runTemplate) is further gated to **creator OR workspace admin** — enforced in `ScheduleService.update`
  (route/MCP inject `actor={subject,isAdmin}`; a patch touching only `enabled`, i.e. pause/resume, stays
  member+). Web mirrors this (edit button + edit page gated to creator/admin; the control plane is authoritative).
- **Web** — a Schedules page with a **view switcher (list / by owner / calendar, `?view=` deep-link)** over shared
  owner·status·runtime filters: each row shows the **owner** (members-joined avatar), **runtime** chip,
  **benchmark→harness**, a human-readable **cadence** (`describeCron`), and the **next fire** (authoritative or
  (estimated)); an **Upcoming runs** timeline (next 7 days) merges upcoming fires across the visible schedules; the
  calendar marks each day's active schedules (`firesOnDate`, one chip per schedule/day so dense crons don't
  smear). Plus an enable/pause toggle, and a **"Schedule with these settings"** button on the scorecard run form (reuse the form
  values → `POST /schedules`). Cron picker (presets daily/weekly/hourly + raw expression).

### Reuse vs new

| Piece | Status |
|---|---|
| `ScorecardService.submit` / `RunScorecardInput` / `trendSeries` / `diffScorecards` / `onComplete` | **reused verbatim** |
| Temporal client/worker, `/internal` token guard, `ScorecardStore`, registries | **reused** |
| `ScheduleStore` (`@everdict/db`) + migration | **new** |
| `ScheduleService` + `ScheduleDriver` (`TemporalScheduleDriver`) | **new** |
| `scheduledScorecardWorkflow` + activities (submit / status / notify) | **new** (`@everdict/orchestrator`) |
| `/schedules` routes + MCP tools + `schedules:*` authz | **new** (`apps/api`) |
| Schedules web page + "Schedule" button | **new** (`apps/web`) |

## Slices (pnpm gates green at each)

1. ✅ **Schedule SSOT** — `ScheduleStore` (`InMemory` + `Pg` + mig 0027), Zod schema + 5-field cron validation;
   `ScheduleService` CRUD; `/schedules` routes + MCP parity + `schedules:*` roles; web list/create. *(Testable
   with no Temporal.)*
2. ✅ **Temporal driver** — `ScheduleDriver` seam + `TemporalScheduleDriver` (`apps/api`; `ScheduleClient`
   create-or-recreate + delete, env-gated), `ScheduleService` syncs DB↔Temporal on create/update/remove (+ DB
   rollback if `ensure` fails) + `fire()` (submit as creator, record `last*`); `scheduledScorecardWorkflow`
   (poll-to-terminal) + `fireScheduledScorecard`/`scheduledScorecardStatus` activities (HTTP bridge) + worker
   wiring; `POST /internal/schedules/:id/fire` + `GET /internal/schedules/scorecard-status/:id` (`x-internal-token`).
   Fires a real scorecard on cron. *(fire + driver-sync unit-tested with fakes; Temporal glue is live-verified.)*
3. ✅ **Regression alert + UX** — `fire()` returns previous run id; `finalize()` (workflow calls it after
   poll-to-terminal, via `POST /internal/schedules/:id/finalize`) diffs vs the previous scheduled run and fires
   `NotificationService.notifyRegression` (Mattermost) on a regression + records final `lastStatus`; web cron
   **preset picker** (hourly/daily/weekday/weekly chips → cron string) + last-fire time on the list. *(diff-vs-previous +
   notify decision unit-tested; completion notify already free via scorecard `onComplete`.)* **Creator-left
   auto-disable** shipped: `ScheduleService.disableByCreator(tenant, createdBy)` (disable + Temporal pause + reason
   in `lastStatus`), wired via `MembershipService.onMemberRemoved` (single core → HTTP + MCP leave/remove both
   covered). Follow-up: **connection-revoked** auto-disable (indirect dependency schedule→dataset→case.connectionId
   — needs dataset resolution; deferred).

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
(trend/diff) · [workspace-scoped-integrations.md](./workspace-scoped-integrations.md) (private-repo token lifecycle) ·
[self-hosted-runner.md](./self-hosted-runner.md) (runtime online-ness) · rules `orchestrator` / `api-layer` / `auth`.


## Auto-disable on a deterministic fire failure

A CONFIG-class submit failure at fire time (deleted dataset/harness, revoked credentials/authz, invalid
template, exhausted budget — `classifyFailure` class `config`) is deterministic: the same fire fails the same
way on every tick, so firing on is pure noise. The schedule is AUTO-DISABLED with a visible reason
(`lastStatus: "Auto-disabled: <code> — <message>"`) and the Temporal schedule is paused (`driver.ensure`),
the same pattern as creator-left auto-disable. Transient (infra) failures rethrow — the firing workflow's
activity retry owns those, and the schedule stays enabled.
