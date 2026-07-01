# Service-topology target generalization — the target axis (design)

> **Status: B1 + B2 DONE.** Round 2 of front-door generalization. Round 1
> (`front-door-generalization.md`) made *driving* harness-agnostic (request / completion / correlation / image)
> and explicitly deferred the **target axis** as a follow-up ("`harness`-provided target observation needs a
> `TopologyRuntime.observe`-style method"). This doc supersedes that guess: the clean decomposition is a
> **`TargetAcquirer`** seam (WHAT-target) that contributes **named wiring coordinates** + reuses the *already-landed*
> `delivery` observation seam (`reference`/`sentinel`/`egress` — `observation-source.ts`), not a new runtime method.
>
> Sequenced so the live e2e (`scripts/live/service-topology-{nomad,k8s}.mjs`) stays green at every step. Every new
> knob is optional and its default reproduces today's CDP-browser dispatch exactly.

## Problem

A `kind:"service"` topology harness is meant to be harness-agnostic. Round 1 generalized *how the agent is driven*.
But the **target environment** the agent acts on is still hardcoded to one shape: **"a CDP browser that Assay
provisions per case."** A real harness often gets its browser elsewhere — a **session API** (Browserbase / Steel /
a `playwright-server` the topology itself runs) that returns a *bundle* of connection coordinates over HTTP. That
does not fit today, in three coupled places:

### The three target hardcodes (current code)

1. **The target is always *provisioned* by Assay.** `dispatch` calls `runtime.provisionBrowserEnv`
   (`service-backend.ts:77`) whenever `spec.target` is set; each `TopologyRuntime` unconditionally runs a per-case
   headless-Chromium container and discovers its CDP (`docker-runtime.ts:89`, `nomad-runtime.ts:274`,
   `k8s-runtime.ts:202`). There is **no way to say "the browser is provided by service X via an API"** — i.e. open a
   session on a declared topology service and use *its* coordinates. (Round 1 named this the deferred
   `target.acquire: "harness"`.)
2. **The handle carries exactly one coordinate.** `BrowserEnvHandle = { cdpUrl: string; snapshot; dispose }`
   (`topology-runtime.ts:9-13`). A session browser exposes **several** coordinates at once
   (`playwright_server_url`, `action_stream_url`, `session_id`, a CDP url, …); a single `cdpUrl` string cannot
   represent them.
3. **The wiring vocabulary is browser-use-shaped + closed.** `dispatch` builds the per-run wiring `extra` as a
   fixed `{ task, target_cdp_url }` (`service-backend.ts:91-94`); `wiringVars` (`environment-manager.ts:33`) adds
   `run_id` + the `isolateBy`-derived store keys. So a `bodyTemplate` (round-1 #1) can only reference
   `{{task}}/{{run_id}}/{{thread_id}}…/{{target_cdp_url}}`. **There is no standard path to inject
   `{{playwright_server_url}}` / `{{session_id}}`** that a specific service requires.

These are one problem wearing three hats: the target is modeled as *a CDP browser Assay owns*, not as *an acquired
environment that contributes named coordinates + an observation surface*.

## Root cause — the target axis was never abstracted

`dispatch` already assembles three orthogonal seams (the model-B doctrine, extended in round 1):

| Concern | Axis | Seam | Status |
| --- | --- | --- | --- |
| **Placement** — where to deploy | infra-agnostic | `TopologyRuntime` | ✅ Nomad/K8s/Docker parity |
| **Driving** — build → submit → await → correlate | harness-agnostic | `FrontDoorDriver` | ✅ round 1 |
| **Observation delivery** — how the snapshot reaches the grader | delivery-agnostic | `ObservationSource` | ✅ reference/sentinel/egress |
| **Target** — *what* env the agent acts on + *how it's acquired* | acquisition-agnostic | — | ❌ hardcoded to provision-a-CDP-browser |

The fourth seam is missing. `provisionBrowserEnv` conflates *acquiring* the target (which strategy) with
*provisioning a container* (one specific strategy), and `BrowserEnvHandle` conflates *the agent's connection
coordinates* with *one CDP url*.

## Direction — a `TargetEnvHandle` (bag of coordinates) + a `TargetAcquirer` seam

Two changes, mirroring the round-1 pattern (each hardcode → an optional knob defaulting to today):

1. **Generalize the handle** from one coordinate to a **named bag** that flows into the wiring vocabulary:

```ts
// @assay/topology — topology-runtime.ts (replaces BrowserEnvHandle)
interface TargetEnvHandle {
  wiring: Record<string, string>;   // named coordinates → merged into per-run wiring (was: cdpUrl: string)
  snapshot(): Promise<EnvSnapshot>; // observation surface (unchanged; reference-mode pull)
  dispose(): Promise<void>;
}
```

The CDP-browser runtimes return `{ wiring: { target_cdp_url: cdpUrl }, snapshot, dispose }` — today's single
coordinate is just a one-entry bag. `dispatch` merges `...target.wiring` into the per-run `extra` instead of the
fixed `{ target_cdp_url }`. **That alone closes #2(handle) and #3(vocabulary)**: the body template can now reference
any coordinate name the target declares.

2. **Make acquisition pluggable** behind a `TargetAcquirer` (the WHAT-target sibling of `TopologyRuntime`/
   `FrontDoorDriver`/`ObservationSource`), selected by a new optional `target.acquire`:

```ts
// @assay/topology — target-acquirer.ts (new)
interface TargetAcquirer {
  acquire(req: AcquireRequest): Promise<TargetEnvHandle>;
}
function targetAcquirerFor(target: TopologyTarget, runtime: TopologyRuntime, io): TargetAcquirer;
```

- `acquire: { mode: "provision" }` (**default** — absent `acquire` = this) → delegates to
  `runtime.provisionBrowserEnv` and maps `cdpUrl → wiring.target_cdp_url`. **Bit-for-bit today.**
- `acquire: { mode: "service", … }` → opens a session on a **declared topology service** over HTTP (no Assay
  container), maps the response fields into named wiring coordinates, and closes the session on `dispose()`.
  Infra-agnostic (just HTTP to a `topo.endpoints[service]`), so it lives next to `FrontDoorDriver`, **not** in the
  runtime — the runtime only knows how to *provision*, not how to *call a session API*.

`dispatch` becomes the assembler of **four** orthogonal seams:
`{ TopologyRuntime (WHERE) · TargetAcquirer (WHAT) · FrontDoorDriver (HOW-drive) · ObservationSource (HOW-observe) }`.

### Observation composes with the existing delivery seam — no new path

A `service`-acquired target has no Assay-owned browser to CDP-snapshot. We do **not** invent a new observation
method (round 1's `TopologyRuntime.observe` guess). Instead it reuses the **already-landed** `delivery` axis
(`harness-spec.ts:33-40`, `observation-source.ts`):

- `delivery: sentinel` — the service/agent returns the observation inline on the result channel.
- `delivery: egress` — the service/agent pushes the observation to a sink; the grader pulls it.
- default `reference` — the acquirer's own `snapshot()` returns a `{kind:"prompt"}` (trace-only), since there is
  no Assay-managed store to pull from.

So **acquisition (wiring + lifecycle) and observation (delivery) stay orthogonal**, exactly as they already are for
the provisioned browser.

## The three hardcodes → the knobs

Every knob is optional; its default reproduces today's behavior.

| # | Knob (proposed) | Default (= today) | Reuses |
| --- | --- | --- | --- |
| B1 (handle) | `BrowserEnvHandle.cdpUrl: string` → `TargetEnvHandle.wiring: Record<string,string>`; `dispatch` merges `...target.wiring` | `{ target_cdp_url: cdpUrl }` — identical body | the round-1 `wiringVars` `extra` merge (`service-backend.ts:91`) |
| B1 (vocabulary) | per-run wiring vocabulary is open-ended (= whatever the target contributes) | only `target_cdp_url` present | `bodyTemplate` `{{var}}` interpolation (`interpolateTemplate`) |
| B2 (acquire) | `target.acquire`: `provision` \| `service` (open/coordinates/close over a declared service) | `provision` = `runtime.provisionBrowserEnv` | `getField` dot-path; `interpolatePath` `{var}`; the `delivery` seam for observation |

## Proposed contract (sketch)

```ts
// @assay/core — harness-spec.ts: TopologyTargetSchema gains `acquire` (optional; absence = provision = today)
target?: {
  kind: "browser"; engine: "chromium";
  extension?: { ref: string };
  lifecycle: "per-case-instance" | "per-case-context";
  observe: ("dom" | "screenshot" | "url")[];
  delivery?: ObservationDelivery;            // unchanged (reference | sentinel | egress)
  // NEW — how the target env is acquired. Absent = { mode: "provision" } = today's per-case CDP browser.
  acquire?:
    | { mode: "provision" }                                                    // runtime spins a per-case browser
    | { mode: "service";
        service: string;                      // a name in spec.services that offers a session API
        open: string;                         // "POST /sessions" — open a session (method+path, like frontDoor.submit)
        coordinates: Record<string, string>;  // wiringVarName → dot-path into the open response
                                              //   e.g. { target_cdp_url:"cdp_url", playwright_server_url:"ws.endpoint",
                                              //          session_id:"id" }  → all become {{...}} wiring vars
        close?: string };                     // "DELETE /sessions/{session_id}" — dispose ({var} ← wiring)
};
```

```ts
// @assay/topology — topology-runtime.ts: handle generalized (cdpUrl → wiring)
interface TargetEnvHandle { wiring: Record<string,string>; snapshot(): Promise<EnvSnapshot>; dispose(): Promise<void>; }
// provisionBrowserEnv keeps its signature but returns wiring:{ target_cdp_url } (all 3 runtimes; internal CDP usage
// for snapshot() is unaffected — cdpUrl was only ever a wiring coordinate for the agent).

// @assay/topology — target-acquirer.ts (new): the WHAT-target seam
interface TargetAcquirer { acquire(req: AcquireRequest): Promise<TargetEnvHandle>; }
type AcquireRequest = { spec: ServiceHarnessSpec; runId: string; endpoints: Record<string,string>; zone?: TrustZone };
// targetAcquirerFor(target, runtime, io):
//   undefined target           → no acquirer (dispatch provisions nothing; trace-only, today's #4)
//   { mode:"provision" }/absent → provisionAcquirer(runtime)  → runtime.provisionBrowserEnv → { target_cdp_url }
//   { mode:"service", … }       → serviceAcquirer(io)         → open session, map coordinates→wiring, close on dispose
// io = injectable { submit, getJson } primitives (same fakes as HttpFrontDoorDriver — deterministic unit tests).
```

The session acquirer is the **mirror of the front-door driver, for the target**: `open` is the target's `submit`,
`coordinates` is its `correlate` (dot-path extraction, but a *bag* not one id), `close` is its lifecycle teardown.
It deliberately reuses `methodPath`/`joinUrl`/`interpolatePath`/`getField` from `front-door-driver.ts`.

## "Absorbing the control-plane" — concretely (continued from round 1)

Round 1 absorbed (a) request, (b) hold-until-done, (c) correlate, (e) image. The target was the one piece still
assumed to be *Assay's own browser*. B1+B2 absorb (d): a harness that brings its own session browser declares
`acquire: service` + `coordinates`, and Assay opens/maps/closes it as spec data. That completes the absorption.

## Sequencing (keep the live e2e green)

Each step merges independently; defaults keep current behavior, so no regression. Live e2e
(`scripts/live/service-topology-{nomad,k8s}.mjs`) provisions a CDP browser → stays on the `provision` default.

1. **B1 — handle + vocabulary. ✅ DONE.** `BrowserEnvHandle` → `TargetEnvHandle` (`wiring` bag, `snapshot` widened
   to `EnvSnapshot`); the 3 runtimes return `wiring:{ target_cdp_url }`; `dispatch` merges `...target.wiring` (and the
   legacy body reads `target.wiring.target_cdp_url`). Pure refactor — wiring still contains `target_cdp_url`, so the
   default body is byte-identical. Unblocked open-ended `bodyTemplate` vocabulary (#3/#4): a test feeds a target
   contributing `playwright_server_url`/`session_id` and asserts they interpolate. Live `.mjs` scripts migrated.
2. **B2 — `acquire: service`. ✅ DONE.** `target.acquire` (`provision` | `service`) on `TopologyTargetSchema` —
   auto-mirrors to `ServiceTemplateSpecSchema` (it reuses the same schema; `resolveHarnessInstance` passes `target`
   through). New `target-acquirer.ts`: `provisionAcquirer` (default, delegates to `runtime.provisionBrowserEnv`) +
   `serviceAcquirer` (open → `coordinates` dot-path map → wiring bag, `close` on dispose; method-aware `AcquireRequestFn`
   so DELETE works) + `targetAcquirerFor`. `dispatch` selects the acquirer and passes base wiring for open/close
   interpolation; `acquireRequest` is an injectable backend option. Coordinate-mapping failure best-effort-closes the
   half-open session. Unit tests (`target-acquirer.test.ts`) + a dispatch test (coordinates → bodyTemplate, no runtime
   browser, close on dispose). Absent `acquire` = `provision` = today.
3. **`acquire.ready` — session readiness gate. ✅ DONE.** A `service`-mode session can be opened before its client
   (the browser that back-connects to the session server) has self-registered; a front-door command issued in that
   window 404s. Optional `acquire.ready` (`{ service?, poll: "GET /path", intervalMs, timeoutMs }`) makes
   `serviceAcquirer` poll a status URL (injectable `ProbeFn`, default `fetchProbe` = 2xx?; path `{var}`-interpolated
   with wiring **+ coordinates**, so `{session_id}` resolves) until 2xx **before** returning the handle. Timeout ⇒
   best-effort `close` of the half-open session (same no-leak discipline as coordinate-mapping failure) then
   `UpstreamError`. Absent `ready` = no gate = today. (`open` request body/headers templating remains open — below.)

## Touch points (for the eventual PR)

- `packages/core/src/harness-spec.ts` — `TopologyTargetSchema.acquire` (discriminated union; absence = provision).
- `packages/core/src/harness-template.ts` — mirror `acquire` in `TemplateServiceSchema`/the service template spec.
- `packages/topology/src/topology-runtime.ts` — `BrowserEnvHandle` → `TargetEnvHandle` (`cdpUrl` → `wiring`).
- `packages/topology/src/{docker,nomad,k8s}-runtime.ts` — return `wiring:{ target_cdp_url: cdpUrl }`.
- `packages/topology/src/target-acquirer.ts` — **new**: `TargetAcquirer` + `provisionAcquirer` + `serviceAcquirer`
  + `targetAcquirerFor`; reuse `methodPath`/`joinUrl`/`interpolatePath`/`getField` from `front-door-driver.ts`.
- `packages/topology/src/service-backend.ts` — `dispatch` selects a `TargetAcquirer`; merge `...target.wiring`.
- `packages/topology/src/observation-source.ts` — unchanged (already the observation seam B2 composes with).
- Docs/skill: `docs/service-harness.md` (target section) + the `topology` skill reference travel with the code.

## Out of scope (later)

- `kind:"os"` / non-browser targets (the `acquire` seam is kind-agnostic, but no os-target schema yet).
- A target that the **front-door agent itself** mints mid-run and reports back (would need a target trace-ref) —
  the deferred completion `callback` mode (round 1) is the natural carrier.
- `acquire.open` request body templating / headers (mirror of the still-open round-1 `request.headers` knob).
</content>
</invoke>
