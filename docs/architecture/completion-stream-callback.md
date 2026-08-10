# Front-door completion — stream & callback modes (design)

> **Status: C1 + C2 DONE.** Round 3 of front-door generalization. Round 1
> (`front-door-generalization.md`) landed the completion model with `sync` + `poll` and explicitly deferred
> `stream`/`callback` as "extensions, not core to the generalization." This doc designs those two modes. Round 2
> (`target-acquisition-generalization.md`) generalized the target axis. Every mode here is additive; absent
> `completion` = `sync` = today (no regression), and `poll` is unchanged.

## Problem

`FrontDoorCompletion` (`@everdict/contracts`, `harness-spec.ts`) is `sync | poll`. Both assume a **request/response**
shape: `sync` = the submit response IS the result; `poll` = GET a status endpoint until a terminal `StatusMatch`.
`HttpFrontDoorDriver` (`front-door-driver.ts`) encodes this — `fetchSubmit` does `res.json()` (one parse), and
`awaitCompletion` is a GET-poll loop.

Two real agent protocols don't fit:

1. **Streaming submit (A2A `message/stream`, SSE).** The POST itself returns `text/event-stream`; the agent emits a
   sequence of events and signals completion with a **terminal event** (A2A: a `TaskStatusUpdateEvent` with
   `final: true` / `status.state ∈ {completed, failed, canceled}`). `res.json()` cannot read this — the body is a
   stream, not one JSON document. There is no abstraction to consume it.
2. **Fire-and-forget + callback (A2A push-notification / webhook).** Submit returns an immediate ack; the agent runs
   asynchronously and later **POSTs its terminal result to a callback URL** that the caller supplied. Everdict neither
   exposes a callback URL (no `{{callback_url}}` wiring var) nor has any way to *await an inbound* request.

`poll` can sometimes stand in for (1)/(2) if the agent also exposes a status endpoint — but a stream-only or
push-only agent has none, and polling a streaming agent throws away its incremental signal.

## Design — two more `completion.mode`s, same terminal vocabulary

Both modes reuse the **`StatusMatch`** data-matcher (dot-path `field` + `equals`/`oneOf`, no eval — same discipline
as `poll`) to decide done/failed, and both produce the **same `DriveOutcome { traceRef, status, response }`** so
trace correlation (`correlate`) and observation (`delivery` sentinel/egress) are unchanged downstream. The only new
surface is *how the terminal signal arrives*.

```ts
// @everdict/contracts — harness-spec.ts: FrontDoorCompletionSchema gains two variants (discriminatedUnion "mode")
completion?:
  | { mode: "sync" }                                                              // today (default)
  | { mode: "poll";   statusPath; done; failed?; intervalMs?; timeoutMs? }        // today
  // NEW — the submit response is itself an SSE/chunked stream; match a terminal EVENT.
  | { mode: "stream";
      done: StatusMatch; failed?: StatusMatch;     // matched against each PARSED stream event (getField dot-path)
      timeoutMs?: number }                          // wall-clock cap on the whole stream
  // NEW — fire-and-forget; the agent POSTs its terminal result to {{callback_url}} (Everdict-provided rendezvous).
  | { mode: "callback";
      done?: StatusMatch; failed?: StatusMatch;     // optional match on the posted body (absent = any POST = done)
      timeoutMs?: number };
```

### `stream` — read the submit response as events
- Submit is a POST whose response is `text/event-stream` (or chunked JSON-lines). The driver consumes the body as a
  sequence of **parsed events**; for each event it evaluates `failed` then `done` (`StatusMatch` via `getField`),
  stopping at the first match. Timeout / stream-end-without-match → `timeout` (run fails, same as poll).
- The **result-channel body** (`DriveOutcome.response`, what `sentinel` observation reads) = the **terminal matched
  event**. `correlate: returned` extracts the agent's id from the **first** event (A2A mints the `Task.id` up front)
  — so a peeked first event feeds `resolveTraceRef`, exactly where the single submit response feeds it today.
- New injectable primitive on `HttpFrontDoorDriverIo`: `openStream(url, payload) => AsyncIterable<unknown>`
  (default = fetch + an SSE/JSON-lines parser yielding parsed `data:` payloads; tests inject a fake async iterable —
  fully deterministic, no real socket). `submit` stays the POST primitive for `sync`/`poll`; `stream` uses
  `openStream` instead (chosen by `completion.mode`), so the `res.json()` assumption is never hit for streams.

### `callback` — await an inbound terminal POST
- Everdict exposes a **rendezvous URL** per run and injects it into the wiring as **`{{callback_url}}`** (so a
  `bodyTemplate` or A2A `pushNotificationConfig` can hand it to the agent). Submit is fire-and-forget (the response is
  ignored except for `correlate: returned`). The driver then **awaits the inbound POST** to that URL, matches the
  posted body with `done`/`failed` (absent `done` = any inbound POST counts as done), and uses the posted body as the
  result channel.
- New injectable seam `CallbackRendezvous`: `url(runId): string` (the `{{callback_url}}` value) + `await(runId,
  {timeoutMs}): Promise<{ status, body }>`. Two concrete impls, chosen at wiring time, NOT in the driver:
  - **in-process** (self-hosted runner / dev / single-process control plane) — a tiny HTTP receiver keyed by
    `run_id`, resolves a promise on the matching POST.
  - **control-plane endpoint** (SaaS, `apps/api`) — a public `POST /internal/frontdoor-callback/:runId` that lands
    the body in a store keyed by `run_id`; `await` long-polls/subscribes that store. (Mirrors how `egress`
    observation already retrieves an agent-pushed payload — this is the *inbound completion* analog.)
- This is the heavier mode: it needs a reachable receiver + run-id correlation + auth on the inbound POST. It is
  sequenced **second** and behind the same injectable discipline so the driver stays unit-testable with a fake
  rendezvous.

## Wiring vocabulary
`callback` adds one variable to the per-run wiring: **`callback_url`** = `rendezvous.url(runId)` (a `{run_id}`-keyed
URL). It joins `run_id`, the `isolateBy`-derived store keys, `task`, and the target's coordinates
(`target_cdp_url`/…) — the same single vocabulary `bodyTemplate` and `statusPath` already interpolate. `stream` adds
no new variable.

## Sequencing (keep the live e2e green)
Each step is additive; absent `completion` stays `sync`. Live e2e (`scripts/live/service-topology-{nomad,k8s}.mjs`)
uses `sync`/provisioned-browser → untouched.
1. **C1 — `stream`. ✅ DONE.** Schema variant + `OpenStreamFn`/`fetchStream` primitive + `driveStream` branch
   (consume events, match terminal, first-event correlate, wall-clock + AbortController timeout). Self-contained
   (reads the submit response; no external receiver). Unit-tested with a fake async iterable (done/failed/stream-end
   timeout/wall-clock timeout/returned-correlate). A live check vs a real A2A `message/stream` agent is the
   validation step.
2. **C2 — `callback`. ✅ DONE.** Schema variant + `CallbackRendezvous` seam (`url`/`wait`) + `{{callback_url}}`
   wiring + `driveCallback` branch (fire-and-forget submit → `wait` loop, interim-skip, done/failed match, timeout).
   - **C2a** — `InProcessCallbackRendezvous` (run-keyed queue + waiter, `deliver` for the receiver; `CallbackSink`
     for the inbound side); `service-backend` injects it + adds `callback_url` to the wiring. Unit-tested.
   - **C2b** — control-plane endpoint: public `POST /frontdoor-callback/:runId` (capability-URL auth via the
     unguessable UUID runId — **not** `/internal/**`), wired in `main.ts` to **one shared** `InProcessCallbackRendezvous`
     (outbound `url`/`wait` → topology backend; inbound `deliver` → the route) gated on `EVERDICT_CALLBACK_BASE_URL`.
     No MCP parity — a webhook receiver has no tenant-facing BFF analog. (Superseded for deployment: `StoreCallbackRendezvous`, below.)

## Touch points (for the eventual PR)
- `packages/contracts/src/harness/harness-spec.ts` — add `stream` + `callback` variants to `FrontDoorCompletionSchema`
  (+ mirror nothing else — `frontDoor` already flows through `ServiceTemplateSpecSchema`).
- `packages/topology/src/front-door/front-door-driver.ts` — `HttpFrontDoorDriverIo.openStream?` + `callbackRendezvous?`;
  `awaitCompletion` grows `stream`/`callback` branches; `drive` peeks the first stream event for `correlate`.
- `packages/topology/src/service-backend.ts` — inject the rendezvous; add `callback_url` to `wiringVars` extra when
  `completion.mode === "callback"`; surface `openStream`/`callbackRendezvous` as backend options (like
  `submit`/`getJson`/`acquireRequest`).
- `apps/api` (C2 follow-up) — the public callback endpoint + store + auth, behind the `CallbackRendezvous` interface.
- Docs/skill: `docs/service-harness.md` (completion section) + the `topology` skill reference travel with the code;
  flip the `front-door-generalization.md` follow-up note when each mode lands.

## Out of scope (later)
- Bidirectional streaming / mid-run input to the agent (A2A `message/stream` is one-way consume here).
- Resubscribe/resume of a dropped A2A stream (`tasks/resubscribe`) — a reconnect concern, not completion semantics.
- Per-event trace ingestion from the stream (we take the trace via `traceSource` as today; stream events drive
  *completion*, not trace assembly).
</content>


## Store-backed rendezvous (multi-replica)

`StoreCallbackRendezvous` (apps/api) + `CallbackStore` (`@everdict/db`, migration `0050_frontdoor_callbacks`)
replace the single-process assumption: `deliver` persists the inbound body to the shared store and the driving
replica's `wait` polls a CLAIM — a `FOR UPDATE SKIP LOCKED` single-row consume, so exactly one waiter takes each
body even with several replicas polling. `main.ts` wires the Pg store when `DATABASE_URL` is set and the
in-memory store otherwise (single-process dev — equivalent to the old in-process rendezvous). The route and the
topology backend are unchanged: the same object implements both the sink (`deliver`) and the outbound
rendezvous (`url`/`wait`). Consumed/stale rows are swept opportunistically on deliver (callbacks are plumbing,
not history).

## `trace` completion (round 4) — the trace IS the terminal signal

For agents whose submit **blocks for the whole run** (or returns nothing useful) and whose only reliable output
channel is their observability trace: `completion: { mode: "trace", intervalMs?, timeoutMs? }`.

- **Submit is fired, monitored, never awaited as the signal.** `driveTrace` starts the submit without blocking on its
  (possibly run-long) response, but its rejection is NEVER discarded: a dead front door (conn refused / non-2xx) fails
  the drive on the next probe tick. This is the contract-level fix for the downstream defect where a
  `void submit().catch(() => {})` burned the entire case budget while "never started" was indistinguishable from
  "still working". On drive end the held submit socket is aborted (released), win or lose.
- **Completion = the run's trace reaching a terminal state.** The driver polls an injected `TraceReadyFn`
  (`() => "pending" | "done" | "failed"`) — the backend builds it from the resolved trace source *before* the drive
  (per-dispatch workspace source > fixed runtime source; resolution failure here fails the run — no probe, no signal).
  State-aware platforms implement the optional `TraceSource.status(ref) → "absent"|"running"|"ok"|"error"`
  (MLflow reads `TraceInfo.state`; a stateless server degrades to presence); a source without `status` is probed
  presence-based (`fetch(ref).length > 0` = done). Probe key = `frontDoor.contextId ?? runId` — the same key the
  post-drive pull uses. A transient probe throw is treated as not-ready (retried); persistent failure surfaces as the
  completion timeout.
- **Correlation restrictions (registration-time `superRefine`):** `correlate: "returned"` and `traceInline` are
  rejected with trace completion — the submit response is never awaited, so there is nothing to extract from it.
  Use injected correlation or `contextId`.
- **Result channel:** none (`DriveOutcome.response` is undefined) — `sentinel` observation does not apply; pair with
  `reference`, `trace`, or `egress` delivery.

Also landed with this round (front-door failure truthfulness):
- `{var}` tokens in the **submit path** are now interpolated with the per-run wiring in all drive paths (sync/poll/
  stream/callback/trace) — previously only `statusPath`/session paths interpolated, so a `POST
  /sessions/{session_id}/command` submit reached the agent percent-encoded (`%7Bsession_id%7D` → 422).
- A **non-2xx submit** (node-http and stream) rejects with the status + body excerpt instead of flowing the error body
  downstream as a bogus correlation/result payload; the poll status GET distinguishes a permanent 4xx (fail now, real
  cause) from a transient 5xx/network error (keep polling within the budget).
- The **session-open** primitive (`fetchAcquire`, target acquisition) surfaces HTTP failures the same way — a 422 open
  no longer masquerades as "no value at session_ids.0" in coordinate mapping.
