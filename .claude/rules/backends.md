---
paths: "packages/backends/**"
---
# Backend rules (push)

A Backend = placement: dispatch a runner-agent job to an orchestrator. See skill `backends`.

- **Tenant-registered runtimes** (BYO compute): a `RuntimeSpec` (`@assay/core`, local|nomad|k8s, no secrets) →
  live `Backend` via `buildRuntimeBackend(spec, {secretEnv})`. The control plane's `RuntimeDispatcher` resolves a
  job's `placement.target` to the tenant's `RuntimeSpec`, builds + registers the backend under
  `rt:<tenant>:<id>@<version>`, and routes via the `Scheduler` (fairness/budget/capacity preserved). Credentials
  come from the tenant `SecretStore` (`secretEnv`) — never from the spec. **Two distinct credential roles, keep
  them separate**: (a) the agent's model keys → injected into the job/alloc env; (b) the **control-plane→cluster-API**
  token (`spec.authSecret` names the SecretStore entry) → sent as the API auth header (`X-Nomad-Token` /
  `kubectl --token`+`server`) and **stripped from the alloc/pod env** (`nomadRuntimeOptions`/`k8sRuntimeOptions`)
  so the cluster admin token is never exposed to untrusted eval code. See `docs/runtimes.md`.

- Implement `Backend.dispatch(job: AgentJob): Promise<CaseResult>` AND `capacity(): Promise<{total, used}>`
  (`./backend`, `@assay/core`). `capacity()` is what the `Scheduler` gates on — report a configured
  `maxConcurrent` as `total`; live-probe the cluster for `used` where cheap (else `used: 0`).
- Do NOT run the harness here. Dispatch the `@assay/agent` image with the job as
  `ASSAY_AGENT_JOB` (base64 JSON) env; the agent runs `runCase` and prints the `__ASSAY_RESULT__`
  sentinel. Parse the CaseResult from job logs (v1) — keep transport swappable (HTTP callback later).
- Isolation is the orchestrator's (`Nomad task runtime` / K8s `runtimeClassName`), set via config — never hardcoded.
- Inject auth via `collectAuthEnv()` (`@assay/agent`) into the job env; never log or commit it.
- Map orchestrator failures to `UpstreamError`; never leak a raw HTTP/SDK error.
- Placement: `Router` = static (pin/default, dev); `Scheduler` = capacity-aware + **tenant-fair** (WFQ via
  `FairQueue` keyed by `AgentJob.tenant`, `weightFor`/`tenantQuota`) + queue + backpressure (the SaaS path;
  the `assay worker` uses it). Both satisfy `Dispatcher` — depend on that, not the class. `PlacementPolicy`
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
