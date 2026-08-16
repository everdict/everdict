---
paths: "packages/backends/**"
---
# Backend rules (push)

A Backend = placement: dispatch a job-runner job to an orchestrator. See skill `backends`.

- **Tenant-registered runtimes** (BYO compute): a `RuntimeSpec` (`@everdict/contracts`, local|nomad|k8s,
  no secrets; `local` = dev/control-plane-host, superseded for "my machine" by the self-hosted runner) →
  live `Backend` via `buildRuntimeBackend(spec, {secretEnv})`. The control plane's `RuntimeDispatcher` resolves a
  job's `placement.target` to the tenant's `RuntimeSpec`, builds + registers the backend under
  `rt:<tenant>:<id>@<version>`, and routes via the `Scheduler` (fairness/budget/capacity preserved). Credentials
  come from the tenant `SecretStore` (`secretEnv`) — never from the spec. **Two distinct credential roles, keep
  them separate**: (a) the agent's model keys → injected into the job/alloc env; (b) the **control-plane→cluster-API**
  credential (`spec.authSecret` = ACL/bearer token; k8s `spec.kubeconfigSecret` = full kubeconfig YAML) → used
  **only** for cluster-API auth (`X-Nomad-Token` / `kubectl --token`+`server` / `kubectl --kubeconfig <temp 0600>`,
  removed in `finally`) and **stripped from the alloc/pod env** (`nomadRuntimeOptions`/`k8sRuntimeOptions` via
  `withoutKeys` — strip BOTH `authSecret` and `kubeconfigSecret`) so the cluster credential is never exposed to
  untrusted eval code. k8s auth precedence: `kubeconfigSecret` > (`server`+`authSecret`) > `context`. The decrypted
  kubeconfig is materialized **per-dispatch** (never in the long-lived backend ctor). See `docs/runtimes.md`.

- **Anything that takes compute passes the admission gate** (execution-model §5.1) — an eval submit, a
  sandbox session, a file run, a browser session. The order is fixed: `admitCausedWork` (the causer's
  envelope 402 + depth/in-flight guards 429, when an agent asked) then `BudgetTracker.admit` (tenant 402),
  BEFORE any container is provisioned, and `release()` on any failure that produced nothing. The causer id
  is never client-supplied — it rides the agent attribution header. A new lane that takes compute and skips
  this is a bypass, and the master plan makes a bypass a review-blocking defect. What the hold-open lanes do
  NOT share is `Scheduler.dispatch`: it is task-shaped (queue → run → result), and a session has no result
  to await, so it would park a slot forever. They share admission, and their held-open jobs are counted by
  the same `capacity()` probe (all submit under the `everdict-` prefix).

- Implement `Backend.dispatch(job: CaseJob): Promise<CaseResult>` AND `capacity(): Promise<{total, used}>`
  (`./backend`, `@everdict/contracts`). `capacity()` is what the `Scheduler` gates on — report a configured
  `maxConcurrent` as `total`; live-probe the cluster for `used` where cheap (else `used: 0`).
- **Capabilities are typed, not optional methods.** `Backend` is the CORE (`dispatch`+`capacity`+`id`) — anything
  beyond it (`Recoverable`=adopt/kill, `Observable`=logs/caseEvents/exec, `Shellable`=execStream, `ScreenCapturable`=
  captureScreen, `Probeable`=probe, `Inspectable`=inspect [read-only live cluster view: nodes/capacity/workload/
  stores, best-effort→`warnings`], `CaseInspectable`=inspectCase [case-scoped placement: phase queued|blocked|
  starting|running|dead + blocked capacity verdict + unit/node/events — wire SSOT `CasePlacement`],
  `TopologyInspectable`=inspectTopology/topologyServiceLogs [service-topology health roster + service log tail,
  harness-keyed; ServiceTopologyBackend only], `PoolReporting`=poolStats [last session-pool readings for the
  /metrics gauges — never a live probe], `CaseCapacityAware`=capacityFor [harness-keyed capacity: the Scheduler
  consults it per job so each harness is admitted by ITS pool on a shared runtime; must answer from already-
  probed readings, cheap enough for per-job-per-round], `Reclaimable`=stopWorkload/reclaimIdle/purgeTerminal/setNodeSchedulable
  [DESTRUCTIVE control, admin-only `runtimes:control`, best-effort/idempotent, stores never reclaimed],
  **session mode** = the `Driver` contract itself (`provision`/`reap`/optional `snapshot`), guarded by
  `isSessionable` — a target that can HOLD compute open (agent worlds / the playground) as well as run a case to
  completion; Nomad + Docker have it, K8s does not, and the session lane must narrow rather than build a parallel
  driver class for the same cluster [a second owner re-derives the address/token/namespace/trust zone and its
  sessions go uncounted by `capacity()`]) is a SEPARATE
  interface the backend also `implements`, and consumers narrow
  with the matching guard (`isObservable(backend)`), never a `backend.logs?.()` feature-detect. Don't add a new
  optional method to `Backend`; add/extend a capability interface + its `is*` guard. If a backend can't do a
  capability, it simply doesn't implement that interface (e.g. K8s is not `Shellable` — no interactive stream exec).

- **Destructive control takes the WORK HANDLE, never a semantic case id** (`WorkAddressable.killWork(work:
  RuntimeWorkRef)`, arch-review 52 Wave 2). A case id names a GROUP of executions — two runs of one case are two
  live jobs — so `Recoverable.kill(caseId)` stops other runs' (and, on Nomad's `namespace=*` sweep, other TENANTS')
  compute — and it did so silently, because kill returned void. Every backend that creates external work
  therefore REPORTS the exact handle at the moment it creates it (`DispatchOptions.onWork`, best-effort, right after the K8s apply /
  Nomad submit; never fired for a job with no `runId`), and the control plane PERSISTS it on the physical-attempt
  ledger row (`ExecutionAttemptStore.recordWork`, `runtime_work` jsonb, mig 0185) so it outlives the dispatching
  process — a teardown after a restart has nothing else to address live compute with. `killWork` addresses the
  exact external id in the WORK'S OWN namespace: never a prefix scan, never `namespace=*`, never a selector another
  run shares. `kill(caseId)` survives only as the no-handle fallback (legacy rows, lanes that mint none) and is
  called INSTEAD of `killWork`, never beside it. K8s label values a selector selects on must be INJECTIVE —
  `caseSlug` truncates at 50 chars, so `caseLabelValue`/`runLabelValue` append a digest whenever slugging lost
  information, and every job carries `everdict.dev/run` beside `everdict.dev/case`.
- **A stop ANSWERS — `KillOutcome`, never `void`** (arch-review 52 Wave 3). `kill`/`killWork` return
  `{status: "stopped"|"absent"|"unknown"|"failed", reason?}` and still never throw: `stopped`/`absent` are
  convergence (`killConverged`), `unknown`/`failed` mean the compute is probably still burning. "The delete
  request returned" and "the job stopped" were the same observation before, so a cancellation certified freed
  compute on the strength of a process exiting. Rules for a new backend: a listing that FAILED is `unknown`,
  never `absent` (a sweep that learned nothing stopped nothing); a sweep that ran and matched nothing IS
  `absent`; a 404 / `--ignore-not-found` with no output is `absent`; anything else non-2xx is `failed` with
  the cluster's own words. A fan-out (shard list, several handles) reports the WORST outcome
  (`worstKillOutcome`) — a teardown that stopped three jobs and could not reach the fourth has not converged.
  The seams above it (`composition/runtime-access.ts`) aggregate and never `.catch(() => {})`.
- **Failure evidence rides the throw.** The orchestrator job + raw log are deleted/GC'd right after settlement, so
  dispatch-failure paths capture evidence AT THROW TIME: attach `extra.placement {unit,node,events[]}` +
  `extra.logTail` (stderr-preferred, sentinel-stripped, 16 KB tail) to the thrown `UpstreamError` —
  `classifyFailure` lifts them onto `CaseFailure.placement`/`logTail` and the batch path seals the tail into the
  trajectory as a `log` trace event. A new backend's failure paths must do the same (best-effort, never mask the error).
- Do NOT run the harness here. Dispatch the `@everdict/job-runner` image with the job as
  `EVERDICT_CASE_JOB` (base64 JSON) env; the agent runs `runCase` and prints the `__EVERDICT_RESULT__`
  sentinel. Parse the CaseResult from job logs (v1) — keep transport swappable (HTTP callback later).
- Isolation is the orchestrator's (`Nomad task runtime` / K8s `runtimeClassName`), set via config — never hardcoded.
- **The control-plane API never uses `LocalBackend` — by default, no toggle.** `LocalBackend` (in-process host,
  no isolation) is dev/CLI only. `main.ts` never registers a `local` backend, and `RunService`/`ScorecardService`
  `submit` reject (400, `assertRuntimeTarget`) any run/scorecard with no execution target — no `runtime`
  (tenant `RuntimeSpec` id) and no `self:<id>`/`self:ws` target. Fail-fast at submit; **never a silent fallback
  to in-process host execution**. This is the API's fixed policy (`main.ts` wires the gate on unconditionally —
  there is **no** `EVERDICT_REQUIRE_RUNTIME`-style env flag); the service's `requireRuntime` boolean exists only so
  mock-dispatcher unit tests stay valid. Target existence is still validated later by `RuntimeDispatcher`/`Scheduler`
  (`NOT_FOUND`). In-process single-host dev execution lives in `apps/cli` (`everdict run`). See `docs/execution-backends.md`.
- **Cancellation is promise-tied, via `dispatch(job, opts?: DispatchOptions)`'s optional `signal`** (not only the
  id-keyed `kill(caseId)`). Pollers stop the poll on abort (`abortableDelay`) and reclaim the orchestrator job;
  in-process/pull backends refuse a not-yet-started run. Reject with the shared `dispatchAborted(job)` (`CANCELLED`).
  Thread `opts` through every `Dispatcher` wrapper (Router/Scheduler + the apps/api chain); the `Scheduler` also
  drops a signal that aborts while QUEUED. `AdoptOutcome` (`adopted|absent|unknown`) keeps "no job" distinct from
  "couldn't determine" so boot recovery never re-dispatches (double-spends) a possibly-live job on a transient error.
- Inject auth via `collectAuthEnv()` (`@everdict/job-runner`) into the job env; never log or commit it.
- Map orchestrator failures to `UpstreamError`; never leak a raw HTTP/SDK error.
- Placement: `Router` = static (pin/default, dev); `Scheduler` = capacity-aware + **tenant-fair** (WFQ via
  `FairQueue` keyed by `CaseJob.tenant`, `weightFor`/`tenantQuota`) + queue + backpressure (the SaaS path;
  the `everdict worker` uses it). Both satisfy `Dispatcher` — depend on that, not the class. `PlacementPolicy`
  must be pure/deterministic. Backpressure = `RateLimitError` (429), never a silent drop. A multi-tenant
  scheduler must never let one tenant starve another — fairness is enforced, not best-effort.
- Multi-tenant secrets & budgets (keyed by `CaseJob.tenant`): inject a tenant's model keys via a
  `SecretProvider` (`secretsFor(tenant)`) into ONLY that tenant's alloc env — never a global key, never cross
  tenants. Enforce per-tenant `BudgetTracker` at the `Scheduler`: `admit` before queuing (over-limit ⇒
  `PaymentRequiredError` 402; reserve `runs` so bursts can't overshoot), `settle(cost)` on completion. Budget
  rejection is explicit (402), never a silent drop.
- Autoscaling: the `Autoscaler` reads `Scheduler.stats()` (queue depth + in-flight) and drives `ScalingTarget`s
  to grow/shrink capacity (`desiredCapacity` is pure; upscale immediate, downscale after hysteresis). A backend's
  `maxConcurrent` may be `() => number` so scaling takes effect next placement pass; after a scale, re-pump via
  `Scheduler.poke()`. Actuation is abstracted — in-memory `MutableSlots` or a callback to Nomad Autoscaler/ASG/K8s.
  The topology lane has its own loop (`TopologyPoolAutoscaler`, @everdict/topology): a harness declaring
  `acquire.capacity.scale {min,max}` opts its session service into replica scaling via
  `TopologyRuntime.serviceReplicas/scaleService` (K8s only; the Nomad co-located group cannot address one
  service) — demand = pool saturation + that harness's queued backlog, wired in apps/api
  `composition/topology-autoscaler.ts`.
- Tenant isolation: eval = untrusted code. A backend with a `TrustZonePolicy` resolves `tenant → TrustZone`
  and applies it per dispatch — set the docker `runtime`/`Namespace` from the zone and call
  `assertHardenedIsolation` (untrusted tenants MUST get runsc/kata, never shared-kernel runc). Default to
  `perTenantTrustZones()` (each tenant its own zone). **Never share a warm pool across tenants** — key it by
  `(spec, version, zone.id)`. Only relax for explicitly `trusted` first-party tenants.
