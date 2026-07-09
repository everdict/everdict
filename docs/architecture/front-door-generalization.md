# Service-topology front-door generalization — absorbing the control-plane (design)

> **Status: all 5 core knobs DONE.** Sequenced so the live e2e (`scripts/live/service-topology-{nomad,k8s}.mjs`)
> stays green at every step. Each knob is optional and defaults to today's behavior. Follow-ups landed in later
> rounds: completion `stream`/`callback` modes (round 3 — `completion-stream-callback.md`), the target axis
> (round 2 — `target-acquisition-generalization.md`, superseding the `TopologyRuntime.observe` guess) and the
> `request.headers`/`method` knob (`frontDoor.request.headers` + the method honored from `submit`'s verb — landed).
> No core front-door follow-ups remain.
> - **#2 completion model — DONE.** `FrontDoorDriver` (the harness-agnostic sibling of `TopologyRuntime`) +
>   `HttpFrontDoorDriver` landed in `@everdict/topology`; `frontDoor.completion` (`sync` | `poll`) in `@everdict/core`;
>   `ServiceTopologyBackend.dispatch` now delegates driving to the driver and fails a run on completion timeout.
>   Default (no `completion`) = `sync` = today. (`stream`/`callback` modes deferred — see #2 below.)
> - **#3 correlation — DONE.** `frontDoor.correlate` (`injected` | `returned`). `returned` extracts the agent's
>   own trace-id from the submit response via a dot-path (`correlate.path`) and uses it for **both** the trace
>   fetch **and** the poll `statusPath` (`{run_id}` is overridden with the agent id). `injected` (default) =
>   correlate by the Everdict runId = today. `SubmitFn` now returns the response body for this.
> - **#1 payload template — DONE.** `frontDoor.request.bodyTemplate` — a JSON body whose string `{{var}}` tokens
>   are interpolated over the per-run wiring (CommandHarness convention). The wiring variable **names** now derive
>   from `dependencies[].isolateBy` (`thread_id`/`key_prefix`/`object_prefix`/`schema`) via `wiringVars`, not the
>   hardcoded LangGraph names. Absent `request` = today's 5-field body (no regression).
> - **#4 target observation — DONE (none/everdict).** Browser provisioning is now gated on `spec.target` (already
>   optional in the schema, previously ignored): present → provision + observe (today); **absent → no browser, a
>   trace-only run with a `{kind:"prompt"}` (no-stage) snapshot** — no core-contract change (reuses the prompt-env
>   snapshot; `CaseResult.snapshot` stays required). The `harness`-provided target (observe a declared service's own
>   CDP endpoint) needs a `TopologyRuntime.observe`-style method and is the remaining follow-up.
> - **#5 per-service image pin — DONE.** `AgentJob.imagePins` (service name → image) overrides registered service
>   images at dispatch. `applyImagePins` folds the pins into a deterministic effective version (`-pin-<hash>`), so
>   `topologyJobId` (id@version-keyed) separates pinned variants with **no runtime change**; an unknown service name
>   is rejected (`BadRequestError`). Absent `imagePins` = unchanged.
>
> **Strict generalization, not a clean break.** Unlike the harness-taxonomy rework, this one keeps full
> backward behavior: every new knob is optional and its default reproduces today's browser-use-langgraph
> dispatch exactly. A spec that sets nothing new dispatches identically to today.

## Problem

A `kind:"service"` topology harness is supposed to be **harness-agnostic** (any agent topology) and
**infra-agnostic** (Nomad / K8s alike). The infra axis is clean — `TopologyRuntime` abstracts placement and is
live-verified at Nomad↔K8s parity. The harness axis is **not**: `ServiceTopologyBackend.dispatch`
(`packages/topology/src/service-backend.ts`) is written for exactly one protocol — browser-use-langgraph — in
five hardcoded places. A different agent (different request shape, async multi-step completion, its own trace id,
its own browser, a per-dispatch image) does not fit.

The goal is to **absorb what an external orchestrator does** (build the request, hold the connection until the
agent finishes, correlate the trace, manage the target env, pick the per-service image) into Everdict as declarative
spec data — not to attach Everdict to an external control-plane.

### The five hardcodes (current code)

1. **Front-door payload is fixed.** `service-backend.ts:82-88` POSTs
   `{ task, thread_id, stream_channel, minio_prefix, browser_cdp_url }` verbatim. These are LangGraph/browser-use
   field names; another agent needs a completely different body. The per-run keys themselves are LangGraph-named
   in `environment-manager.ts:12` (`keysFor` → `threadId`/`streamChannel`/`minioPrefix`).
2. **Submit is fire-and-forget.** `SubmitFn = (url, payload) => Promise<void>` (`service-backend.ts:19`); dispatch
   submits then immediately fetches the trace. An async N-step agent needs **holding until completion**; there is
   no abstraction for it.
3. **Trace is fetched by Everdict's runId.** `traceSource.fetch(runId)` (`service-backend.ts:94`). An external agent
   records under **its own** id in MLflow/OTel, so Everdict's runId does not match. The `frontDoor.trace` field exists
   in the schema (`harness-spec.ts:54`) but is **never read** (grep: 0 usages).
4. **The per-case browser is unconditionally provisioned.** `provisionBrowserEnv` is always called
   (`service-backend.ts:71`), even though `spec.target` is already optional (`harness-spec.ts:53`). A harness that
   runs its own playwright-server, or needs no browser at all, does not fit.
5. **The service image is fixed in the spec.** `TopologyService.image` is a required string (`harness-spec.ts:12`);
   there is no per-dispatch image selection. External orchestrators sometimes choose a per-service image at
   dispatch time (e.g. evaluate the same topology with service X at v1 vs v2).

## Root cause — one abstraction is missing

`dispatch` conflates two concerns that the rest of the codebase keeps separate (the placement/compute split:
Backend = *placement*, Driver = *compute*):

| Concern | Axis | Status |
| --- | --- | --- |
| **Placement** — where to deploy | infra-agnostic | ✅ `TopologyRuntime` (Nomad / K8s parity, live) |
| **Driving** — how to drive the agent + collect signal | harness-agnostic | ❌ hardcoded to browser-use-langgraph |

The front-door is **the last adapter that stayed as code** while every sibling became declarative data:
`CommandHarness` (any CLI agent from `HarnessSpec(command)`, no code — `command.ts:81-83` `{{task}}/{{run_id}}`
interpolation), `BenchmarkAdapterSpec` (benchmark = data with `{field}` interpolation), `RuntimeSpec` (execution
infra = user-registered data). The service equivalent of "any CLI agent, no code" is **"any agent topology, no
code"** — which is exactly the stated goal.

## Direction — a declarative `FrontDoorProtocol` + a thin `FrontDoorDriver`

Introduce a **`FrontDoorDriver`** (the harness-agnostic sibling of the infra-agnostic `TopologyRuntime`) that
interprets a declarative **`FrontDoorProtocol`** carried by the spec. `dispatch` shrinks to a fixed skeleton:

```
ensureTopology(spec, zone)                        // WHERE — infra (unchanged)
target   = acquireTarget(spec, runId, zone)       // strategy: none | everdict-browser | harness-service
outcome  = frontDoorDriver.drive(spec, wiring)    // HOW  — build → submit → await-done → return agent trace-ref
trace    = traceSource.fetch(correlate(outcome))  // correlate: injected vs returned id  (wakes frontDoor.trace)
snapshot = target?.observe()                      // optional
grade(trace, snapshot)
```

`ServiceTopologyBackend` becomes the assembler of `{ TopologyRuntime (WHERE), FrontDoorDriver (HOW) }`. This is the
model-B split extended to the service tier.

## The five hardcodes → five declarative knobs

Every knob is optional; its default reproduces today's behavior.

| # | Knob (proposed) | Default (= today) | Reuses |
| --- | --- | --- | --- |
| 1 ✅ | `frontDoor.request.bodyTemplate` — `{{task}}/{{run_id}}/{{thread_id}}/{{target_cdp_url}}…` interpolation (recursive over the JSON body) | the current 5-field body | CommandHarness substitution (`command.ts:81`) — `interpolateTemplate` |
| 1b ✅ | per-run wiring variables derived from `spec.dependencies[].isolateBy` (not hardcoded `keysFor`) | pg→`thread_id`, redis→`key_prefix`, minio→`object_prefix`, +`schema` | the existing `isolateBy` enum (`harness-spec.ts:25`) — `wiringVars` |
| 2 ✅ | `frontDoor.completion.mode`: `sync` \| `poll` (+ `statusPath`, `done`/`failed` `StatusMatch`, `intervalMs`, `timeoutMs`) — `stream`/`callback` deferred | `sync` (current echo behavior) | — (the genuinely missing piece) |
| 3 ✅ | `frontDoor.correlate.mode`: `injected` (Everdict's `run_id`) \| `returned` (extract agent id from the submit response via `correlate.path` dot-path) | `injected` | `getField` dot-path reader; `SubmitFn` widened to return the response (the dormant `frontDoor.trace` *endpoint* stays a separate future capability) |
| 4 ✅ | gate browser provisioning on `spec.target` (present→provision/observe; absent→trace-only `{kind:"prompt"}` snapshot). `harness`-provided target observation = follow-up | provision when `spec.target` set | the already-optional `target` + the `prompt` (no-stage) snapshot — no contract change |
| 5 ✅ | `AgentJob.imagePins` (service name → image) overrides registered images at dispatch; `applyImagePins` folds pins into a deterministic `-pin-<hash>` effective version so warm pools separate variants (no runtime change) | `spec.image` (no pins) | `HarnessTemplate` slot/pins (`harness-template.ts:97-115`); `node:crypto` hash for the version suffix |

Knob 5 is ~80% built: `resolveHarnessInstance` already maps `pins[slot] → image` per service
(`harness-template.ts:99`); it only resolves at *registration*. Threading an optional pin through `AgentJob`
(`agent-job.ts:28`) lets a tenant/case select a per-service image at *dispatch*.

## Proposed contract (sketch)

```ts
// @everdict/core — harness-spec.ts: frontDoor extension (all optional; absence = today)
frontDoor: {
  service: string; submit: string; trace?: string;
  // #2 DONE — completion is a discriminated union; poll uses a *data* matcher (StatusMatch), not a string
  // predicate (no eval; same "data not code" discipline as BenchmarkAdapterSpec).
  completion?:
    | { mode: "sync" }
    | { mode: "poll"; statusPath: string;                 // "GET /runs/{run_id}/status" ({var} ← wiring)
        done: StatusMatch; failed?: StatusMatch;          // StatusMatch = { field: dot-path; equals? | oneOf? }
        intervalMs?: number; timeoutMs?: number };
  // #3 DONE — correlate the trace id. returned extracts from the submit response (dot-path) and also drives the
  // poll statusPath; injected (default) = the Everdict runId. (Distinct from frontDoor.trace, an unused agent-side
  // trace *endpoint*.)
  correlate?:
    | { mode: "injected" }
    | { mode: "returned"; path: string };                                                   // "run_id" | "data.id"
  // #1 DONE — declarative request body; string {{var}} tokens interpolated over the per-run wiring (recursively).
  // wiring NAMES derive from dependencies[].isolateBy via wiringVars (no hardcoded LangGraph names). method is honored
  // from `submit`'s verb; `request.headers` (values {{var}}-interpolated) attach to submit/stream/callback requests.
  request?:    { bodyTemplate?: Record<string, unknown>; headers?: Record<string, string> }; // #1 (+ headers)
  // #4 DONE — no new field: provisioning is gated on the EXISTING optional `spec.target`. Absent target = a
  // trace-only run graded over a {kind:"prompt"} snapshot. A `target.acquire: "harness"` (observe a declared
  // service's own CDP) is the follow-up (needs a TopologyRuntime.observe method).
};

// @everdict/topology — front-door-driver.ts: the HOW abstraction (sibling of TopologyRuntime) — LANDED in #2
interface FrontDoorDriver {
  drive(req: FrontDoorDriveRequest): Promise<DriveOutcome>;   // submit → await-completion (build/correlate grow in #1/#3)
}
type DriveOutcome = { traceRef: string; status: "done" | "failed" | "timeout" };
// HttpFrontDoorDriver is the default impl (injectable submit/getJson/sleep/now for deterministic tests).

// @everdict/core — agent-job.ts (#5): per-dispatch image override (NOT on the spec — it's a run input)
AgentJob.imagePins?: Record<string /* service name */, string /* image */>;
// @everdict/topology — image-pins.ts: applyImagePins(spec, pins) overrides images + appends a deterministic
// `-pin-<hash>` to the effective version, so the warm pool (keyed by id@version) separates pinned variants.
```

The wiring vocabulary generalizes `keysFor` (DONE in #1 via `wiringVars`): each declared dependency contributes a
per-run isolation variable named by its `isolateBy` (`thread_id`/`key_prefix`/`object_prefix`/`schema`), plus
`{{run_id}}`, the case `{{task}}`, and the target handle (`{{target_cdp_url}}`). browser-use happens to want all
three store keys + the CDP url; another harness wants a subset or none. (A `callback`-mode `{{callback_url}}` comes
with the deferred completion modes.)

## "Absorbing the control-plane" — concretely

browser-use's own LangGraph loop did: (a) build the request, (b) hold the connection until the run finishes,
(c) correlate the trace, (d) manage the browser, (e) pick the image. Knobs 1–5 take each of those into Everdict as
spec data. That is absorption, not attachment.

## Sequencing (keep the live e2e green)

Each step merges independently; defaults keep current behavior, so no regression.

1. **#2 completion model** ✅ — the most essential gap; `sync` default = no regression; unlocks async N-step agents.
   Landed: `FrontDoorDriver`/`HttpFrontDoorDriver` + `frontDoor.completion` (`sync`/`poll`) + timeout→fail.
2. **#3 correlation** ✅ — `frontDoor.correlate` (`injected`/`returned`); `returned` extracts the agent's own
   trace-id from the submit response (dot-path) for both trace fetch and poll `statusPath`. `injected` = today.
3. **#1 payload template** ✅ — `frontDoor.request.bodyTemplate` (`interpolateTemplate`) + `wiringVars` deriving the
   per-run variable names from `dependencies[].isolateBy`. Absent `request` = today's 5-field body.
4. **#4 target observation** ✅ — gate provisioning on `spec.target`; absent → trace-only `{kind:"prompt"}` snapshot
   (no contract change). `harness`-provided target observation deferred (needs a `TopologyRuntime.observe` method).
5. **#5 image pin** ✅ — `AgentJob.imagePins` + `applyImagePins` (override images + deterministic `-pin-<hash>`
   effective version so warm pools separate variants, no runtime change). Absent `imagePins` = unchanged.
6. **Default submit on `node:http` (not global `fetch`)** ✅ — undici's `headersTimeout` (default 300s) aborts a
   `sync`-completion harness that holds the response for minutes while the agent runs its N steps; the raw node
   request has no such ceiling. `FrontDoorRequestOpts.timeoutMs` (fed from `completion.timeoutMs`; `sync` has none →
   unbounded) is applied as a **socket idle timeout** — while the server holds the response no bytes flow, so the
   idle window *is* the completion deadline. Socket errors (`ECONNREFUSED`/idle-abort) remap to `UpstreamError`.

## Touch points (for the eventual PR)

- `packages/core/src/harness-spec.ts` — extend the `frontDoor` schema (knobs 1–4); `agent-job.ts` (knob 5 pin).
- `packages/core/src/harness-template.ts` — mirror the `frontDoor` extension in `ServiceTemplateSpecSchema`.
- `packages/topology/src/front-door/front-door-driver.ts` — **new**: the `FrontDoorDriver` interface + a default driver that
  resolves the protocol (request template, completion strategy, correlation, target acquisition).
- `packages/topology/src/service-backend.ts` — shrink `dispatch` to the skeleton; delegate to `FrontDoorDriver`.
- `packages/topology/src/environment-manager.ts` — derive wiring variables from `isolateBy` instead of fixed keys.
- Docs/skill: `docs/service-harness.md` (spec section) + the `topology` skill reference travel with the change.
