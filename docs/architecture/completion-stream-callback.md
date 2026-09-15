---
kind: wiki
title: "Front-door completion — sync, poll, stream, callback and trace modes"
status: current
updated: 2026-09-15
anchors: [packages/topology/src/front-door/front-door-driver.ts, apps/api/src/core/execution/store-callback-rendezvous.ts, apps/api/src/api/execution/frontdoor-callback.routes.ts]
---
# Front-door completion — sync, poll, stream, callback and trace modes

A service-topology harness is driven through its front door: submit a task, then wait until the agent has
finished. `frontDoor.completion` (`FrontDoorCompletionSchema`, `@everdict/contracts` `harness-spec.ts`) declares
HOW the drive learns that. The front-door knobs as a whole are described in
[front-door-generalization.md](./front-door-generalization.md); the target axis in
[target-acquisition-generalization.md](./target-acquisition-generalization.md).

All modes are interpreted by `HttpFrontDoorDriver` (`packages/topology/src/front-door/front-door-driver.ts`) and
end in the same `DriveOutcome { traceRef, status, response? }`, so trace correlation and observation delivery
downstream do not depend on the mode. Absent `completion` = `sync`.

| mode | the terminal signal | result channel (`DriveOutcome.response`) |
| --- | --- | --- |
| `sync` | the submit response itself | the submit response body |
| `poll` | a GET on `statusPath` matching `done`/`failed` | the matching status body |
| `stream` | a parsed event from the submit's SSE body matching `done`/`failed` | the terminal event |
| `callback` | an inbound POST to `{{callback_url}}` matching `done` (or any POST when `done` is unset) | the posted body |
| `trace` | the run's trace reaching a terminal state on the trace source | none |

`done`/`failed` are `StatusMatch` data matchers (dot-path `field` + `equals`/`oneOf`, no eval). Every mode except
`sync` defaults `timeoutMs` to 120000; `sync` takes an optional `timeoutMs` applied as the submit socket's no-flow
cap. Timeout or a stream that ends without a match fails the run.

## `stream`

The submit POST's response is `text/event-stream`. `HttpFrontDoorDriverIo.openStream` (default `fetchStream`)
yields each `data:` payload parsed as JSON (non-JSON data is skipped); `driveStream` evaluates `failed` then `done`
on each event. `correlate: returned` reads the agent's id from the FIRST event (A2A mints the task id up front).
Tests inject a fake async iterable.

## `callback`

Submit is fire-and-forget; the driver then waits on a `CallbackRendezvous` (`url(runId)` / `wait(runId,
timeoutMs)`); the receiving half is `CallbackSink` (`deliver(runId, body)`), both in `front-door-driver.ts`. When the completion mode is `callback`, `ServiceTopologyBackend` adds `callback_url =
rendezvous.url(runId)` to the per-run wiring so a `bodyTemplate` can hand it to the agent. A posted body that does
not match `done` is treated as an interim update and the driver waits for the next POST.

- **Inbound route.** `POST /frontdoor-callback/:runId` (`apps/api/src/api/execution/frontdoor-callback.routes.ts`)
  is public: the unguessable run id is the capability. It is not under `/internal/**`, and it has no MCP twin — a
  webhook receiver has no tenant-facing analog. Without a configured sink it answers 404.
- **Rendezvous.** `StoreCallbackRendezvous` (`apps/api/src/core/execution/store-callback-rendezvous.ts`) implements
  both halves: `deliver` persists the body to a `CallbackStore` (`@everdict/db`, migration `0050_frontdoor_callbacks`)
  and `wait` polls a claim — a `FOR UPDATE SKIP LOCKED` single-row consume, so exactly one waiter takes each body
  even with several replicas. Consumed rows and rows older than an hour are swept on deliver. The composition
  (`apps/api/src/composition/dispatch.ts`) builds it only when `EVERDICT_CALLBACK_BASE_URL` is set, over the Pg store
  when `DATABASE_URL` is set and the in-memory store otherwise; without it a `callback` drive fails explicitly.

## `trace` — the trace is the terminal signal

For agents whose submit blocks for the whole run, or returns nothing useful, and whose only reliable output is
their observability trace: `completion: { mode: "trace", intervalMs?, timeoutMs? }`.

- **Submit is fired and monitored, never awaited as the signal.** `driveTrace` does not block on the response, but
  its rejection is never discarded: a dead front door (connection refused / non-2xx) fails the drive on the next
  probe tick instead of burning the case budget while "never started" reads as "still working". The held submit
  socket is aborted when the drive ends.
- **Completion probe.** The backend builds a `TraceReadyFn` from the resolved trace source before the drive
  (workspace-selected source, else the runtime's fixed source). A source that implements `status(ref)` reports
  `absent | running | ok | error` (MLflow reads its trace state); a source without it is probed by presence
  (`fetch(ref)` returns events = done). The probe key is `frontDoor.contextId ?? runId`, the same key the post-drive
  pull uses.
- **Registration-time refusals** (`FrontDoorSpecSchema.superRefine`): `correlate: "returned"` and `traceInline` are
  rejected with trace completion — nothing is read from the submit response.
- **No result channel**, so `sentinel` observation does not apply; pair with `reference`, `trace` or `egress`.

## Failure truthfulness (all modes)

- `{var}` tokens in the submit path are interpolated with the per-run wiring in every drive path, so
  `POST /sessions/{session_id}/command` does not reach the agent percent-encoded.
- A non-2xx submit rejects with the status and a body excerpt instead of flowing the error body downstream as a
  correlation or result payload. The `poll` status GET fails immediately on a 4xx and keeps polling within the
  budget on a 5xx or network error.
- The session-open primitive of target acquisition (`fetchAcquire`) surfaces HTTP failures the same way.

## Not supported

- Mid-run input to the agent (the stream is consumed one way).
- Resuming a dropped A2A stream (`tasks/resubscribe`).
- Assembling the trace from stream events — the trace still comes from `traceSource` or `traceInline`; stream
  events drive completion only.
