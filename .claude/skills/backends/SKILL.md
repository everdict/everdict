---
name: backends
description: How Everdict dispatches eval runs to execution backends (Nomad/K8s/Windows) — the dispatched job-runner, the CaseJob contract, isolation, secret injection. Use when adding or editing a Backend.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Backends (placement layer)

The control plane (outside clusters) → `Backend.dispatch(CaseJob)` → job-runner runs the
whole `runCase` inside an isolated unit → emits CaseResult (`__EVERDICT_RESULT__` sentinel on stdout).

## Checklist
1. Implement the CORE `Backend` (`packages/backends/src/backend.ts`) = `dispatch` + `capacity` only.
2. Add capabilities as SEPARATE interfaces you also `implements`, never as optional methods on `Backend`
   (see "Capabilities" below). A caller narrows with a guard (`isWorkControllable(backend)`), not `backend.logsForWork`.
3. Dispatch the `@everdict/job-runner` image with the job as `EVERDICT_CASE_JOB` (base64 JSON) env.
4. Isolation = orchestrator runtime (Nomad `runtime`, K8s `runtimeClassName`) — config, not code.
5. Inject auth (`collectAuthEnv()` from `@everdict/job-runner`) into the job env; never log it.
6. Parse the CaseResult from the sentinel line; map failures to `UpstreamError`.

## Capabilities (typed, not optional-method feature-detection)
`Backend` is the CORE contract (`dispatch` + `capacity` + `id`). Everything else a backend can do is a distinct
capability interface it *also* implements, narrowed by a guard — so the compiler tracks who can do what, instead of
a runtime `backend.logs?.()` returning `undefined` on backends that never had it:
- `WorkAddressable` (`killWork(work: RuntimeWorkRef)`) — destructive control addressed by the EXACT work, not by
  what the work was about (arch-review 52 Wave 2). Semantic case identity ≠ physical runtime work identity: two runs
  of one case (a re-evaluation beside a scheduled batch, a shadow beside its baseline, a retry) are two live jobs, so
  the case-id-addressed `kill` this replaced stopped strangers' compute — silently, since it returned void. THE
  CASE-ID SURFACE IS NOW DELETED, not deprecated (arch-review 53): there is no no-handle fallback, because leaving
  one asked every caller to know which of two functions was safe and the answer was never visible at the call site.
  A caller holding no handle answers `unknown` and the cancellation stays owed.
  The backend reports the handle BEFORE it creates the external object (`DispatchOptions.onReserved`, **awaited**;
  a rejection aborts the dispatch — `reserve(job)` is pure, which is what makes that order possible), the caller
  persists it on the physical-attempt ledger row (`ExecutionAttemptStore.recordWork`, mig 0185) so it outlives the
  dispatching process, and teardown calls `killWork` with it. Nomad kills by exact job id in the handle's own
  namespace (no listing at all); K8s deletes the named Job in its namespace. Nomad/K8s implement it; in-process/pull
  backends have no external object to name.
  `killWork` returns a **`KillOutcome`** (`stopped|absent|unknown|failed` + `reason`), never `void` (Wave 3): it
  still never throws, but the caller can tell a stop that happened from one that could not be confirmed, and only
  `stopped`/`absent` (`killConverged`) let a cancellation operation complete. A failed LISTING is `unknown`, not
  `absent`; a fan-out reports `worstKillOutcome`.
- `ManagedWorkControl` (`adoptWork` · `logsForWork` · `eventsForWork` · `execInWork` · `execStreamInWork?` ·
  `inspectWork` · `sampleWork` · `probeWork`) — the rest of the handle-addressed surface, all-or-none per backend.
  `probeWork` answers `WorkPresence` (`live` | `absent` | `unknown{reason}`), which is what a cancellation reads
  back before it may call itself complete: accepted ≠ gone.
- `VerifierDispatchable` (`dispatchVerifier(job: VerifierJob)`) — runs the judging half of a case in a container the
  agent never had (arch-review 56 Wave I). The agent's lane never serialized the hidden tests or the verifier's
  credentials, so the boundaries a same-container verifier had to police by ordering are two different containers
  instead. A managed lane that lacks it cannot host a private verifier and refuses rather than degrading.
- `Reclaimable` (`stopWorkload`/`reclaimIdle`/`purgeTerminal`/`setNodeSchedulable`) — DESTRUCTIVE operator control.
  `POST /runtimes/:id/versions/:version/control` + `control_runtime` MCP, gated on the admin-only `runtimes:control`
  action (distinct from `runtimes:write` viewer+ registration). Command/result SSOT = `RuntimeControlCommand` /
  `RuntimeControlResult` in `@everdict/contracts/wire`. See `docs/architecture/runtime-inspection.md`.

Guards live next to the interfaces: `isWorkAddressable` / `isWorkControllable` / `isVerifierDispatchable` /
`isScreenCapturable` / `isScreenAttachable` / `isProbeable` / `isInspectable` / `isTopologyInspectable` /
`isPoolReporting` / `isCaseCapacityAware` / `isReclaimable` / `isSessionable`. A consumer does
`if (!isWorkControllable(backend)) return; backend.logsForWork(work)` — no `?.`, no `undefined` overload for "not
implemented". If your new backend can't do a capability, just don't implement its interface.
`legacy-case-addressing-guard` is the ratchet that keeps the deleted case-id methods deleted, and it asserts the
replacement set too — a ban whose alternative quietly shrank would push the next caller straight back to a case id.

**Failure evidence rides the throw.** The orchestrator job (and its raw log) is deleted/GC'd right after
settlement, so a dispatch-failure throw is the LAST moment the evidence is reachable: Nomad (`waitForAlloc`
failure paths, `parseResultOrExplain`) and K8s (`waitForJob`) attach `extra.placement {unit, node, events[]}` +
`extra.logTail` (stderr-preferred, sentinel-stripped, `FAILURE_LOG_TAIL_CAP`=16 KB tail) to the thrown
`UpstreamError`; `classifyFailure` (`@everdict/domain`) lifts both onto `CaseFailure.placement`/`logTail`, and
`runSuite`'s synthesized failed result carries the tail as a `log` trace event (sealed into the trajectory).
A new backend's failure paths should do the same — capture before throwing, best-effort.

`adoptWork` returns a three-valued `AdoptOutcome` (`adopted` | `absent` | `unknown`), NOT `CaseResult |
undefined` — `absent` (listing succeeded, no job → safe to re-dispatch) must stay distinct from `unknown` (an
API/parse failure → re-dispatch may double-spend a still-live job). Observability methods return `undefined` for the
single meaning "no live job" and MUST NOT throw (best-effort).

## Cancellation (AbortSignal)
`dispatch(job, opts?: DispatchOptions)` carries an optional `signal`. Honor it: pollers (Nomad/K8s) stop the poll the
moment it aborts (via `abortableDelay`) and reclaim the orchestrator job; in-process/pull backends refuse a
not-yet-started run. Reject with `dispatchAborted(job)` (the shared `CANCELLED` factory). The `Scheduler` also cancels
a signal that fires while the job is still QUEUED (removes the entry, no wasted slot) and forwards the signal to the
backend once in-flight. This is promise-tied cancellation, for work THIS process still awaits; `killWork` is the out-of-band half, for
work that outlived the dispatcher.

## Reference impl
`packages/backends/src/orchestrators/nomad.ts` — `buildNomadJob` (job spec) + `NomadBackend` (submit → poll
alloc → read logs → parse). `LocalBackend` runs in-process (dev). K8s/Windows mirror this shape.

Every `Backend` also implements `capacity(): Promise<{total, used}>` — what the `Scheduler` gates on.
Report a configured `maxConcurrent` as `total` (it may be `number | (() => number)` so the autoscaler
can move it); live-probe the cluster for `used` where cheap (Nomad counts running `everdict-*` jobs), else 0.
`used` is reconciled as `free = total − max(used, schedulerInFlight)` (the `max` handles `used` both INCLUDING and
LAGGING the scheduler's own jobs) — best-effort, so report `0` rather than guess when a live count isn't available.

## Contracts
`CaseJob` (`@everdict/contracts`) = `{ evalCase, harness:{id,version}, tenant? }`. The agent reconstructs the
harness + graders from a registry (`@everdict/job-runner` `makeHarness`/`makeGraders`); graders carry
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
  - **replica-global vs per-replica admission**: the scheduler's five in-flight maps are per PROCESS. The
    tenant quota bounds a workspace, so it is measured against the optional `AdmissionLedger` port
    (`RunStore.inFlightByTenant()` — `running` eval rows, one read per drain, best-effort fallback to the
    local count) and not against the map alone; without it, N replicas grant N quotas. Backend slots/memory/
    cpu and per-harness pool room stay local BY DESIGN — the orchestrator `capacity()` probe and
    `capacityFor`'s live pool reading are already their cross-replica truth. `docs/architecture/multi-replica.md`.
  - **queue + backpressure**: no slot/over-quota ⇒ queue, re-pump on settle (no head-of-line block);
    `maxQueueDepth` ⇒ `RateLimitError` (429). `poke()` re-pumps when capacity grows out-of-band.
  - **budgets**: optional `BudgetTracker` — `admit(tenant)` before queue (over-limit ⇒ `PaymentRequiredError`
    402; `runs` reserved at admit so bursts can't overshoot), `settle(costOf(result))` on completion.

## Tenant isolation, secrets, autoscaling
- **Trust zones** (`TrustZonePolicy`, `perTenantTrustZones`): eval = untrusted code, so each tenant gets its
  own `TrustZone` (hardened `runsc`, `everdict-<tenant>` namespace, deny-cross-tenant). The backend applies it
  per dispatch (docker `runtime` + Nomad `Namespace`) and calls `assertHardenedIsolation` (untrusted ⇒ never
  shared-kernel runc). **Never share warm pools across tenants** (topology keys by zone). WHICH policy is live
  is the operator's `EVERDICT_TRUST_ZONES` (`apps/api` `composition/trust-zones.ts`, announced at boot):
  `runtime-declared` (default — the RuntimeSpec's own runtime/namespace) or `per-tenant` (needs the hardened
  runtime installed + namespaces to exist). Pass it to BOTH lanes — `buildRuntimeBackend({trustZones})` and
  `buildTopologyBackend({trustZones})` — because enforcing on one lane only enforces on neither.
- **Secrets** (`SecretProvider`, `staticSecrets`): inject `secretsFor(tenant)` into ONLY that tenant's
  alloc env — a model key never crosses tenants.
- **Autoscaling** (`Autoscaler`): reads `Scheduler.stats()` (queue depth + in-flight), drives `ScalingTarget`s
  to `desiredCapacity = clamp(inFlight+queued, min, max)`; upscale immediate, downscale after hysteresis.
  Actuation is abstracted (`MutableSlots` in-memory, or Nomad Autoscaler / ASG / K8s patch via a callback).

See `docs/execution-backends.md` for all of the above; the rule `backends.md` has the inlined critical rules.
