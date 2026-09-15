---
kind: wiki
title: "Service-topology target acquisition — the target axis"
status: current
updated: 2026-09-15
anchors: [packages/topology/src/front-door/target-acquirer.ts, packages/topology/src/deploy/topology-runtime.ts]
---
# Service-topology target acquisition — the target axis

A service-topology harness drives an agent that acts on a **target**. The target used to be one shape — a CDP
browser Everdict provisions per case — in three coupled places: dispatch always called
`runtime.provisionBrowserEnv`, the handle carried a single `cdpUrl`, and the per-run wiring vocabulary was the fixed
`{ task, target_cdp_url }`. A harness whose browser comes from a session API (Browserbase, Steel, a
`playwright-server` the topology itself runs) returns a bundle of coordinates over HTTP and did not fit.

The repair is one seam, `TargetAcquirer` (`packages/topology/src/front-door/target-acquirer.ts`), next to the other
three dispatch assembles — `TopologyRuntime` (where), `FrontDoorDriver` (how to drive), `ObservationSource` (how
the observation is delivered); see [front-door-generalization.md](./front-door-generalization.md). The runtime only
knows how to provision a container; calling a session API is infra-agnostic HTTP, so it lives beside the front-door
driver and reuses its `methodPath` / `joinUrl` / `interpolatePath` / `getField`.

## The handle is a bag of coordinates

```ts
// packages/topology/src/deploy/topology-runtime.ts
interface TargetEnvHandle {
  wiring: Record<string, string>; // named coordinates merged into the per-run wiring
  cdpBase?: string;               // control-plane-reachable CDP base, when there is one
  snapshot(): Promise<EnvSnapshot>;
  dispose(): Promise<void>;
}
```

A provisioned browser contributes `{ target_cdp_url }`; a session API contributes whatever coordinates it declares
(`playwright_server_url`, `session_id`, …). `dispatch` merges `...target.wiring` into the wiring, so a
`bodyTemplate` can reference any of them. `cdpBase` is distinct from the agent-facing `target_cdp_url` (usually an
internal alias the control plane cannot reach); it is what the environment recorder and the live screen tap.

## Target kinds and how each is acquired

`TopologyTargetSchema` (`@everdict/contracts`) is a discriminated union of `browser`, `api` and `os`, each with an
optional `acquire`. `targetDefects` refuses a target nobody could obtain where the spec enters.
`targetAcquirerFor(target, runtime, request, io)` picks the strategy:

| target | acquirer | wiring |
| --- | --- | --- |
| any kind with `acquire.mode: "service"` | `serviceAcquirer` — session API on a declared topology service | the declared `coordinates` |
| `browser` without `acquire` (or `provision`) | `provisionAcquirer` → `runtime.provisionBrowserEnv` | `{ target_cdp_url }` |
| `api` with a static `baseUrl` | `staticApiAcquirer` | `{ target_base_url }` |
| `api` without `baseUrl`, or `os`, without a session API | refused (`BadRequestError`) — nothing provisions an API or a desktop | — |
| no `target` | none — a trace-only run | — |

## `acquire: { mode: "service" }`

| field | meaning |
| --- | --- |
| `service` | the name in `spec.services` whose endpoint serves the session API |
| `open` | `"POST /sessions"` — method + path, `{var}`-interpolated with the wiring |
| `coordinates` | wiring variable name → dot-path into the open response; a missing or empty value fails the acquisition |
| `close` | `"DELETE /sessions/{session_id}"` on `dispose()`, interpolated with wiring + coordinates |
| `cdpBase` | dot-path to a control-plane-reachable CDP base; a missing value is recorded, never a failure |
| `ready` | `{ service?, poll, intervalMs, timeoutMs }` — poll until 2xx before handing over the coordinates (a session opened before its browser back-connects 404s front-door commands) |
| `wait` | `{ statuses [409, 429], timeoutMs, intervalMs }` — a refused open with one of these statuses is a full pool: retry until the deadline instead of failing the case |
| `capacity` | `{ service?, poll, total, used?, scale? }` — where the session service reports its pool size; feeds the topology roster (`GET /runs/:id/topology`) and, with `scale`, the replica autoscaler (`packages/topology/src/pool-autoscaler.ts`) |

A coordinate-mapping failure or a readiness timeout best-effort-closes the half-open session before failing, so a
failed acquisition never leaks a session. The session acquirer's own `snapshot()` is a `{kind:"prompt"}` — Everdict
owns no stage there.

## Observation stays on the delivery axis

A session-acquired target adds no new observation method. It composes with `target.delivery`
(`observation-source.ts`): `sentinel` (inline on the result channel), `egress` (pushed to a sink), `trace`
(artifacts referenced from the agent's own trace), or the default `reference`, which for a session target yields
the prompt snapshot. Acquisition (wiring + lifecycle) and observation (delivery) stay orthogonal, as they already
were for the provisioned browser.

## Not supported

- Templated request bodies or headers on `acquire.open` (the open request sends no body beyond `{}` for a POST).
- A target the front-door agent mints mid-run and reports back.
- Provisioning a desktop or an API environment — `os` and session-less `api` targets must be acquired through a
  session API or a static base URL.
