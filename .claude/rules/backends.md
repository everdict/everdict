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
- **Capabilities are typed, not optional methods.** `Backend` is the CORE (`dispatch`+`capacity`+`id`); everything
  beyond it is a SEPARATE interface the backend also `implements`, and consumers narrow with the matching guard
  (`isWorkControllable(backend)`), never a `backend.logsForWork?.()` feature-detect. Don't add a new optional
  method to `Backend`; add/extend a capability interface + its `is*` guard. A backend that cannot do a capability
  simply does not implement it. The live set, each with its guard in `backend.ts`:
  - `WorkAddressable`=killWork · `ManagedWorkControl`=adoptWork/logsForWork/eventsForWork/execInWork/
    execStreamInWork?/inspectWork/sampleWork/probeWork — the handle-addressed control surface, all-or-none
    (`isWorkAddressable` / `isWorkControllable`; see the deletion bullet below for why nothing here takes a case id).
  - `VerifierDispatchable`=dispatchVerifier — runs a `VerifierJob` in a container the agent never had, so the
    hidden tests and the reward namespace are somewhere else entirely rather than somewhere ordered carefully
    (arch-review 56 Wave I). A managed lane without it cannot host a private verifier and must refuse.
  - `ScreenCapturable`=captureScreen · `ScreenAttachable`=screenEndpoint — run-keyed live screen.
  - `Probeable`=probe · `Inspectable`=inspect [read-only live cluster view: nodes/capacity/workload/stores,
    best-effort→`warnings`] · `TopologyInspectable`=inspectTopology/topologyServiceLogs [service-topology health
    roster + service log tail, harness-keyed; ServiceTopologyBackend only].
  - `PoolReporting`=poolStats [last session-pool readings for the /metrics gauges — never a live probe] ·
    `CaseCapacityAware`=capacityFor [harness-keyed capacity: the Scheduler consults it per job so each harness is
    admitted by ITS pool on a shared runtime; answers from already-probed readings, cheap enough per-job-per-round].
  - `Reclaimable`=stopWorkload/reclaimIdle/purgeTerminal/setNodeSchedulable [DESTRUCTIVE control, admin-only
    `runtimes:control`, best-effort/idempotent, stores never reclaimed].
  - **session mode** = the `Driver` contract itself (`provision`/`reap`/optional `snapshot`), guarded by
    `isSessionable` — a target that can HOLD compute open (agent worlds / the playground) as well as run a case to
    completion; Nomad + Docker have it, K8s does not, and the session lane must narrow rather than build a parallel
    driver class for the same cluster [a second owner re-derives the address/token/namespace/trust zone and its
    sessions go uncounted by `capacity()`].

- **Destructive control takes the WORK HANDLE, never a semantic case id** (`WorkAddressable.killWork(work:
  RuntimeWorkRef)`, arch-review 52 Wave 2). A case id names a GROUP of executions — two runs of one case are two
  live jobs — so the case-id-addressed `kill` this replaced stopped other runs' (and, on Nomad's `namespace=*`
  sweep, other TENANTS') compute, silently, because it returned void. Every backend that creates external work
  therefore REPORTS the exact handle BEFORE it creates it (`DispatchOptions.onReserved`, **awaited**, and a
  rejection ABORTS the dispatch — arch-review 53 Wave A replaced Wave 2's post-effect `onWork`; never fired for
  a job with no `runId`), and the control plane PERSISTS it on the physical-attempt ledger row
  (`ExecutionAttemptStore.recordWork`, `runtime_work` jsonb, mig 0185) so it outlives the dispatching process.
  The ordering is the contract: a handle reported AFTER the apply meant a control plane dying in between left
  a running job nothing could address, and `reserve(job)` — pure, no external effect — is what makes the other
  order possible. A caller that cannot record where the work will be must not get the work. `killWork` addresses the
  exact external id in the WORK'S OWN namespace: never a prefix scan, never `namespace=*`, never a selector another
  run shares. There is NO no-handle fallback any more — see the next bullet: a caller holding no handle answers
  `unknown`, and the cancellation stays owed. K8s label values a selector selects on must be INJECTIVE —
  `caseSlug` truncates at 50 chars, so `caseLabelValue`/`runLabelValue` append a digest whenever slugging lost
  information, and every job carries `everdict.dev/run` beside `everdict.dev/case`.
- **THE CASE-ID CONTROL SURFACE IS DELETED** (arch-review 53, legacy removal). The interfaces Recoverable,
  Observable, Shellable, CaseInspectable and CaseSampleable and their methods (adopt/kill/logs/caseEvents/
  exec/execStream/inspectCase/sampleCase) are GONE — written here without backticks because they are no
  longer symbols you can reference, only names you may not reintroduce. They resolved "the newest job of this case", which
  is another run's whenever two runs of one case are live: a stop reached strangers' compute, a log tail showed
  a stranger's output, an exec ran INSIDE a stranger's sandbox, and an adopt attributed a stranger's verdict —
  the last being a decision, not an observation. The whole surface is `ManagedWorkControl` now (`adoptWork` ·
  `logsForWork` · `eventsForWork` · `execInWork` · `execStreamInWork?` · `inspectWork` · `sampleWork`, plus
  `WorkAddressable.killWork`), all-or-none per backend. **A caller holding no handle gets `unknown`, never a
  broader stop** — a self-hosted lane answers `absent` (its teardown is the lease revocation), a managed lane
  answers `unknown` and the cancellation stays owed. `legacy-case-addressing-guard` is the ratchet: it refuses
  a re-declared case-id method AND a re-added capability interface.
- **A SPECIALIZED LANE CALLS THE COMMON DISPATCH, IT DOES NOT RE-IMPLEMENT IT.** `dispatchVerifier` is the
  same protocol as `dispatch` with a different payload — reserve, re-present at the object's birth, submit,
  parse — and the K8s one was written out longhand. It reserved and then applied the Job, losing the
  activation the shared path performs, so a scorecard cancellation could probe absent, settle every child,
  COMPLETE, and the verifier container was then born (arch-review 59 P0-verifier). The Nomad lane reuses
  `dispatch` and kept the step. A copy of a protocol does not stay a copy: it loses whichever transition is
  added next, silently, because nothing type-checks "the same sequence". If a lane genuinely needs a variant,
  the variance is a PARAMETER of the shared function, never a second body.
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
- **AN UNTRUSTED POD CARRIES NO IDENTITY IN OUR CLUSTER.** K8s mounts the namespace's default ServiceAccount
  token into every pod unless the spec says otherwise, and nothing here said otherwise — so every eval Job,
  every topology service and every provisioned dependency came up with a bearer token for our cluster API at
  `/var/run/secrets/kubernetes.io/serviceaccount/token`, in a container running the tenant's image with the
  agent under test inside it. What that reaches depends on what the default SA is bound to in whichever
  cluster an operator pointed a `RuntimeSpec` at, which is precisely why it may not be assumed to be nothing:
  the hardened runtime above is the KERNEL boundary, and a credential handed in at the front door goes around
  it. Every pod spec this repo emits for tenant-supplied code spreads `UNTRUSTED_POD_IDENTITY`
  (`@everdict/domain`, beside `assertHardenedIsolation`) — one owner, because an invariant written at three
  call sites grows its next exception in two of them. Unconditional, including for a `trusted` zone: a
  trusted tenant is one we let share a kernel, not one that needs to call our control plane from inside an
  eval, and no lane has ever used the token — a capability removed, not a policy with a knob.
- Isolation is the orchestrator's (`Nomad task runtime` / K8s `runtimeClassName`), set via config — never hardcoded.
- **The control-plane API never uses `LocalBackend` — by default, no toggle.** `LocalBackend` (in-process host,
  no isolation) is dev/CLI only. `main.ts` never registers a `local` backend, and `RunService`/`ScorecardService`
  `submit` reject (400, `assertRuntimeTarget`) any run/scorecard with no execution target — no `runtime`
  (tenant `RuntimeSpec` id) and no `self:<id>`/`self:ws` target. Fail-fast at submit; **never a silent fallback
  to in-process host execution**. This is the API's fixed policy (`main.ts` wires the gate on unconditionally —
  there is **no** `EVERDICT_REQUIRE_RUNTIME`-style env flag); the service's `requireRuntime` boolean exists only so
  mock-dispatcher unit tests stay valid. Target existence is still validated later by `RuntimeDispatcher`/`Scheduler`
  (`NOT_FOUND`). In-process single-host dev execution lives in `apps/cli` (`everdict run`). See `docs/execution-backends.md`.
- **Cancellation is promise-tied, via `dispatch(job, opts?: DispatchOptions)`'s optional `signal`** — the
  in-flight complement to handle-addressed `killWork`, for work this process is still awaiting. Pollers stop the poll on abort (`abortableDelay`) and reclaim the orchestrator job;
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
  tenants. **And only the MODEL-AUTH NAMES** (`evalContainerSecretEnv`, over `HARNESS_AUTH_ENV_VARS`):
  `secretsFor(tenant)` returns the workspace's WHOLE secret tier — its GitHub App token, its Mattermost bot
  token, its registry passwords, whatever a member saved for an integration — and the process that runs in
  that container is the agent under test, arbitrary code whose `LocalDriver` execs inherit `process.env`.
  The blanket injection was a default that outlived its reason: a harness's DECLARED env (`{secretRef}`) is
  resolved into the job before dispatch, a judge's key rides as `judgeAuth`, and the runner reads only that
  vocabulary from its own environment. Both managed lanes call the ONE filter, so a tenant's exposure never
  depends on which orchestrator placed the job (arch-review 58). Enforce per-tenant `BudgetTracker` at the `Scheduler`: `admit` before queuing (over-limit ⇒
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
