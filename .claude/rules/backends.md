---
paths: "packages/backends/**"
---
# Backend rules (push)

A Backend = placement: dispatch a runner-agent job to an orchestrator. See skill `backends`.

- **Tenant-registered runtimes** (BYO compute): a `RuntimeSpec` (`@everdict/core`, local|nomad|k8s,
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

- Implement `Backend.dispatch(job: AgentJob): Promise<CaseResult>` AND `capacity(): Promise<{total, used}>`
  (`./backend`, `@everdict/core`). `capacity()` is what the `Scheduler` gates on — report a configured
  `maxConcurrent` as `total`; live-probe the cluster for `used` where cheap (else `used: 0`).
- Do NOT run the harness here. Dispatch the `@everdict/agent` image with the job as
  `EVERDICT_AGENT_JOB` (base64 JSON) env; the agent runs `runCase` and prints the `__EVERDICT_RESULT__`
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
- Inject auth via `collectAuthEnv()` (`@everdict/agent`) into the job env; never log or commit it.
- Map orchestrator failures to `UpstreamError`; never leak a raw HTTP/SDK error.
- Placement: `Router` = static (pin/default, dev); `Scheduler` = capacity-aware + **tenant-fair** (WFQ via
  `FairQueue` keyed by `AgentJob.tenant`, `weightFor`/`tenantQuota`) + queue + backpressure (the SaaS path;
  the `everdict worker` uses it). Both satisfy `Dispatcher` — depend on that, not the class. `PlacementPolicy`
  must be pure/deterministic. Backpressure = `RateLimitError` (429), never a silent drop. A multi-tenant
  scheduler must never let one tenant starve another — fairness is enforced, not best-effort.
- Multi-tenant secrets & budgets (keyed by `AgentJob.tenant`): inject a tenant's model keys via a
  `SecretProvider` (`secretsFor(tenant)`) into ONLY that tenant's alloc env — never a global key, never cross
  tenants. Enforce per-tenant `BudgetTracker` at the `Scheduler`: `admit` before queuing (over-limit ⇒
  `PaymentRequiredError` 402; reserve `runs` so bursts can't overshoot), `settle(cost)` on completion. Budget
  rejection is explicit (402), never a silent drop.
- Autoscaling: the `Autoscaler` reads `Scheduler.stats()` (queue depth + in-flight) and drives `ScalingTarget`s
  to grow/shrink capacity (`desiredCapacity` is pure; upscale immediate, downscale after hysteresis). A backend's
  `maxConcurrent` may be `() => number` so scaling takes effect next placement pass; after a scale, re-pump via
  `Scheduler.poke()`. Actuation is abstracted — in-memory `MutableSlots` or a callback to Nomad Autoscaler/ASG/K8s.
- Tenant isolation: eval = untrusted code. A backend with a `TrustZonePolicy` resolves `tenant → TrustZone`
  and applies it per dispatch — set the docker `runtime`/`Namespace` from the zone and call
  `assertHardenedIsolation` (untrusted tenants MUST get runsc/kata, never shared-kernel runc). Default to
  `perTenantTrustZones()` (each tenant its own zone). **Never share a warm pool across tenants** — key it by
  `(spec, version, zone.id)`. Only relax for explicitly `trusted` first-party tenants.
