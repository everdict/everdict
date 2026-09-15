---
kind: wiki
title: "Service-topology front door — a declarative protocol instead of one hardcoded agent"
status: current
updated: 2026-09-15
anchors: [packages/topology/src/front-door/front-door-driver.ts, packages/topology/src/image-pins.ts, packages/topology/src/environment-manager.ts]
---
# Service-topology front door — a declarative protocol instead of one hardcoded agent

A `kind:"service"` topology harness is meant to be harness-agnostic (any agent topology) as well as
infra-agnostic (Nomad / K8s / Docker). The infra axis was clean from the start — `TopologyRuntime` owns placement.
The harness axis was not: `ServiceTopologyBackend.dispatch` (`packages/topology/src/service-backend.ts`) was written
for one protocol, browser-use-langgraph, in five places — a fixed request body with LangGraph field names, a
fire-and-forget submit, trace lookup by Everdict's run id, an always-provisioned browser, and a fixed service image.

Each of those became optional spec data whose default reproduces the old dispatch, so a spec that sets none of
them dispatches exactly as before. The point is to absorb what an external orchestrator did for the agent — build
the request, hold until done, correlate the trace, manage the target, pick the image — into the registered
definition, instead of attaching Everdict to that orchestrator.

## The seams `dispatch` assembles

| Concern | Seam | Where |
| --- | --- | --- |
| WHERE the topology runs | `TopologyRuntime` | `packages/topology/src/deploy/topology-runtime.ts` |
| WHAT target the agent acts on | `TargetAcquirer` | `packages/topology/src/front-door/target-acquirer.ts` — see [target-acquisition-generalization.md](./target-acquisition-generalization.md) |
| HOW the agent is driven | `FrontDoorDriver` (`HttpFrontDoorDriver`) | `packages/topology/src/front-door/front-door-driver.ts` |
| HOW the observation reaches the grader | `ObservationSource` | `packages/topology/src/front-door/observation-source.ts` |

## The knobs (`frontDoor` in `FrontDoorSpecSchema`, `@everdict/contracts`)

| Old hardcode | Knob | Default |
| --- | --- | --- |
| fixed 5-field body | `request.bodyTemplate` — string `{{var}}` tokens interpolated recursively over the per-run wiring (`interpolateTemplate`); `request.headers` (values interpolated); `request.encoding: json \| form` + `request.files` for multipart attachment submits | `{ task, thread_id, stream_channel, minio_prefix, browser_cdp_url }` (the last only when a target exists), plus the front-door service's `perRun` names |
| LangGraph-named keys | per-run wiring names derived from `dependencies[].isolateBy` by `wiringVars` (`thread_id` / `key_prefix` / `object_prefix` / `schema`), plus `run_id`, `task`, the target's coordinates and `callback_url` | — |
| fire-and-forget submit | `completion.mode`: `sync` \| `poll` \| `stream` \| `callback` \| `trace` — see [completion-stream-callback.md](./completion-stream-callback.md) | `sync` |
| trace by Everdict run id | `correlate.mode`: `injected` \| `returned` (dot-path into the submit response; the returned id also fills the poll `statusPath`); `contextId` pulls by an injected session coordinate instead | `injected` |
| always-provisioned browser | provisioning is gated on `spec.target`; absent target = a trace-only run whose snapshot is `{kind:"prompt"}` carrying the result-channel body | provision when `target` is set |
| fixed image | `CaseJob.imagePins` (service name → image) | the registered images |

The submit method is taken from `submit`'s verb (`"POST /runs"`).

**Image pins.** `applyImagePins` (`packages/topology/src/image-pins.ts`) overrides the named services' images and
appends a deterministic `-pin-<hash>` to the effective version, so `topologyJobId` (keyed by id@version) keeps a
pinned variant in its own warm pool with no runtime change. A pin naming an unknown service, or a host-exec service
(no image to replace), is a `BadRequestError`.

**Default submit transport.** The default submit is a raw `node:http`/`node:https` request, not global `fetch`:
undici's `headersTimeout` (300 s) cut off `sync` harnesses that hold the response while the agent works. The
completion's `timeoutMs` is applied as a socket idle timeout — while the server holds the response no bytes flow,
so the idle window is the completion deadline — and socket failures are remapped to `UpstreamError`.

`frontDoor.trace` (an agent-side trace endpoint) is still declared in the schema and read by nothing in dispatch;
trace retrieval goes through `traceSource`, `traceInline` or `correlate`.

## See also

`docs/service-harness.md` (the full service spec) · [topology-portability.md](./topology-portability.md) ·
[suna-harness-gaps.md](./suna-harness-gaps.md) (a real agent mapped through these knobs) · skill `topology`.
