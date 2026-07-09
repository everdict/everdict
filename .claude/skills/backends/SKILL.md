---
name: backends
description: How Everdict dispatches eval runs to execution backends (Nomad/K8s/Windows) — model B runner-agent, the AgentJob contract, isolation, secret injection. Use when adding or editing a Backend.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Backends (placement layer)

Model B: control plane (outside clusters) → `Backend.dispatch(AgentJob)` → runner-agent runs the
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

Guards live next to the interfaces: `isRecoverable` / `isObservable` / `isShellable` / `isScreenCapturable` /
`isProbeable`. A consumer does `if (!isObservable(backend)) return; backend.logs(caseId)` — no `?.`, no `undefined`
overload for "not implemented". If your new backend can't do a capability, just don't implement its interface.

## Reference impl
`packages/backends/src/nomad.ts` — `buildNomadJob` (job spec) + `NomadBackend` (submit → poll
alloc → read logs → parse). `LocalBackend` runs in-process (dev). K8s/Windows mirror this shape.

Every `Backend` also implements `capacity(): Promise<{total, used}>` — what the `Scheduler` gates on.
Report a configured `maxConcurrent` as `total` (it may be `number | (() => number)` so the autoscaler
can move it); live-probe the cluster for `used` where cheap (Nomad counts running `everdict-*` jobs), else 0.

## Contracts
`AgentJob` (`@everdict/core`) = `{ evalCase, harness:{id,version}, tenant? }`. The agent reconstructs the
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
