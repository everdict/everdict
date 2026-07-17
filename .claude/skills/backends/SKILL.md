---
name: backends
description: How Everdict dispatches eval runs to execution backends (Nomad/K8s/Windows) — the dispatched runner-agent, the AgentJob contract, isolation, secret injection. Use when adding or editing a Backend.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Backends (placement layer)

The control plane (outside clusters) → `Backend.dispatch(AgentJob)` → runner-agent runs the
whole `runCase` inside an isolated unit → emits CaseResult (`__EVERDICT_RESULT__` sentinel on stdout).

## Checklist
1. Implement the CORE `Backend` (`packages/backends/src/backend.ts`) = `dispatch` + `capacity` only.
2. Add capabilities as SEPARATE interfaces you also `implements`, never as optional methods on `Backend`
   (see "Capabilities" below). A caller narrows with a guard (`isObservable(backend)`), not `backend.logs`.
3. Dispatch the `@everdict/agent` image with the job as `EVERDICT_AGENT_JOB` (base64 JSON) env.
4. Isolation = orchestrator runtime (Nomad `runtime`, K8s `runtimeClassName`) — config, not code.
5. Inject auth (`collectAuthEnv()` from `@everdict/agent`) into the job env; never log it.
6. Parse the CaseResult from the sentinel line; map failures to `UpstreamError`.

## Capabilities (typed, not optional-method feature-detection)
`Backend` is the CORE contract (`dispatch` + `capacity` + `id`). Everything else a backend can do is a distinct
capability interface it *also* implements, narrowed by a guard — so the compiler tracks who can do what, instead of
a runtime `backend.logs?.()` returning `undefined` on backends that never had it:
- `Recoverable` (`adopt` + `kill`) — jobs that outlive the control plane (Nomad/K8s). In-process/pull backends omit it.
- `Observable` (`logs` + `exec`) — live-progress read + one-shot exec (Nomad + K8s).
- `Shellable` (`execStream`) — interactive PTY-over-WS. **Nomad only** (`nomad alloc exec -i`); K8s has no stream exec.
- `ScreenCapturable` (`captureScreen(runId)`) — topology backends' per-RUN browser frame (keyed by runId, not caseId).
- `Probeable` (`probe`) — connection test without a job.
- `Inspectable` (`inspect`) — read-only live cluster view for the runtime detail screen: composition (nodes/DCs, plus
  each node's OS/arch/kernel/container-runtime/agent-version/IP/disk, best-effort), concurrent capacity, the live
  workload placed on it — everdict units AND external (`role:"other"`) services co-resident on the nodes, with
  `namespace`/`ownerKind` — and pool shared stores. A superset of probe (Nomad + K8s). TOTAL/best-effort — a
  partial-cluster failure lands in the result's `warnings`, never throws. Result schema = the SSOT
  `InspectRuntimeResult` in `@everdict/contracts/wire`, reused type-only by the interface (no drift). apps/api wraps it
  (`makeRuntimeInspector`, like the prober) behind `GET /runtimes/:id/versions/:version/inspect` + `inspect_runtime`
  MCP (both `runtimes:read`).
- `Reclaimable` (`stopWorkload` / `reclaimIdle` / `purgeTerminal` / `setNodeSchedulable` / `resizeWorkload`) —
  DESTRUCTIVE control paired with Inspectable, for the runtime detail screen's admin actions. The first four are
  best-effort/idempotent (a gone target is a no-op; shared stores never reclaimed; cluster-infra namespaces refused).
  `stopWorkload(name, namespace?)` and `resizeWorkload(name, {cpu?,memoryMb?}, namespace?)` take the unit's namespace
  to target an EXTERNAL unit (K8s: delete/patch the pod's ROOT controller; Nomad: the namespaced job). `resizeWorkload`
  is the ONE deliberately loud method — an unsupported target (multi-task/multi-container, K8s Job, bare pod, empty
  resize) THROWS an AppError, never a silent no-op. apps/api wraps it (`makeRuntimeController`) behind
  `POST /runtimes/:id/versions/:version/control` + `control_runtime` MCP, gated the NEW admin-only `runtimes:control`
  action (distinct from `runtimes:write` viewer+ registration). Command/result SSOT = `RuntimeControlCommand` /
  `RuntimeControlResult` in `@everdict/contracts/wire`. See `docs/architecture/runtime-inspection.md`.

Guards live next to the interfaces: `isRecoverable` / `isObservable` / `isShellable` / `isScreenCapturable` /
`isProbeable` / `isInspectable` / `isReclaimable`. A consumer does `if (!isObservable(backend)) return; backend.logs(caseId)` — no `?.`, no `undefined`
overload for "not implemented". If your new backend can't do a capability, just don't implement its interface.

`Recoverable.adopt` returns a three-valued `AdoptOutcome` (`adopted` | `absent` | `unknown`), NOT `CaseResult |
undefined` — `absent` (listing succeeded, no job → safe to re-dispatch) must stay distinct from `unknown` (an
API/parse failure → re-dispatch may double-spend a still-live job). Observability methods return `undefined` for the
single meaning "no live job" and MUST NOT throw (best-effort).

## Cancellation (AbortSignal)
`dispatch(job, opts?: DispatchOptions)` carries an optional `signal`. Honor it: pollers (Nomad/K8s) stop the poll the
moment it aborts (via `abortableDelay`) and reclaim the orchestrator job; in-process/pull backends refuse a
not-yet-started run. Reject with `dispatchAborted(job)` (the shared `CANCELLED` factory). The `Scheduler` also cancels
a signal that fires while the job is still QUEUED (removes the entry, no wasted slot) and forwards the signal to the
backend once in-flight. This is promise-tied cancellation, complementing the id-keyed `kill(caseId)` side channel.

## Reference impl
`packages/backends/src/orchestrators/nomad.ts` — `buildNomadJob` (job spec) + `NomadBackend` (submit → poll
alloc → read logs → parse). `LocalBackend` runs in-process (dev). K8s/Windows mirror this shape.

Every `Backend` also implements `capacity(): Promise<{total, used}>` — what the `Scheduler` gates on.
Report a configured `maxConcurrent` as `total` (it may be `number | (() => number)` so the autoscaler
can move it); live-probe the cluster for `used` where cheap (Nomad counts running `everdict-*` jobs), else 0.
`used` is reconciled as `free = total − max(used, schedulerInFlight)` (the `max` handles `used` both INCLUDING and
LAGGING the scheduler's own jobs) — best-effort, so report `0` rather than guess when a live count isn't available.

## Contracts
`AgentJob` (`@everdict/contracts`) = `{ evalCase, harness:{id,version}, tenant? }`. The agent reconstructs the
harness + graders from a registry (`@everdict/agent` `makeHarness`/`makeGraders`); graders carry
their config via `GraderSpec` (`{id, config?}`), e.g. tests-pass `{ cmd }`. `tenant` keys all the
multi-tenant machinery below (the agent ignores it).

## Placement & the SaaS operational layer
Two dispatchers (both satisfy `Dispatcher` — `dispatch(job)→CaseResult`; depend on the interface):
- `Router(registry, defaultTarget)` — static (pin via `evalCase.placement.target`, else default). Dev.
- `Scheduler(registry, opts)` — the SaaS path; the `everdict worker` and `apps/api` use it. It composes:
  - **capacity-aware placement**: `free = total − max(used, in-flight)` per backend; `PlacementPolicy`
    (`leastLoadedPolicy` spread default / `binPackPolicy` consolidate); honors `placement.target` as a hard pin.
  - **tenant fairness**: `FairQueue` (WFQ by virtual-finish time, keyed by `tenant`; `weightFor`) so one
    tenant's batch can't starve another; `tenantQuota` caps a tenant's concurrent in-flight.
  - **queue + backpressure**: no slot/over-quota ⇒ queue, re-pump on settle (no head-of-line block);
    `maxQueueDepth` ⇒ `RateLimitError` (429). `poke()` re-pumps when capacity grows out-of-band.
  - **budgets**: optional `BudgetTracker` — `admit(tenant)` before queue (over-limit ⇒ `PaymentRequiredError`
    402; `runs` reserved at admit so bursts can't overshoot), `settle(costOf(result))` on completion.

## Tenant isolation, secrets, autoscaling
- **Trust zones** (`TrustZonePolicy`, `perTenantTrustZones` default): eval = untrusted code, so each tenant
  gets its own `TrustZone` (hardened `runsc`, `everdict-<tenant>` namespace, deny-cross-tenant). The backend
  applies it per dispatch (docker `runtime` + Nomad `Namespace`) and calls `assertHardenedIsolation`
  (untrusted ⇒ never shared-kernel runc). **Never share warm pools across tenants** (topology keys by zone).
- **Secrets** (`SecretProvider`, `staticSecrets`): inject `secretsFor(tenant)` into ONLY that tenant's
  alloc env — a model key never crosses tenants.
- **Autoscaling** (`Autoscaler`): reads `Scheduler.stats()` (queue depth + in-flight), drives `ScalingTarget`s
  to `desiredCapacity = clamp(inFlight+queued, min, max)`; upscale immediate, downscale after hysteresis.
  Actuation is abstracted (`MutableSlots` in-memory, or Nomad Autoscaler / ASG / K8s patch via a callback).

See `docs/execution-backends.md` for all of the above; the rule `backends.md` has the inlined critical rules.
