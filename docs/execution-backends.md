# Execution backends (Backend vs Driver)

Two layers decide *where a harness run executes*:

- **Driver** (`@assay/core`, in-sandbox compute): runs the harness as a subprocess INSIDE an
  already-isolated unit. The runner-agent uses `LocalDriver`.
- **Backend** (`@assay/backends`, placement): dispatches a runner-agent job to an orchestrator
  and returns the `CaseResult`. Isolation is the orchestrator's job, not Assay's.

## Model B (runner-agent)
The control plane (outside the clusters) builds an `AgentJob` and hands it to a `Backend`:
`dispatch(job)` → runs `@assay/agent` (`runAgentJob`) inside an isolated unit → the agent does
the whole `runCase` and prints the `CaseResult` on stdout behind the `__ASSAY_RESULT__`
sentinel → the Backend parses it.

| Backend | Target | Isolation | Status |
|---------|--------|-----------|--------|
| `LocalBackend` | this host (in-process) | none | dev |
| `NomadBackend` | on-prem Nomad (batch alloc, docker driver) | docker `runtime` (e.g. `runsc`=gVisor) | **phase 1** |
| `K8sBackend` | cloud + on-prem K8s (Job) | `runtimeClassName` (gVisor/Kata) | phase 2 |
| `WindowsBackend` | on-prem Windows node pool | Hyper-V VM checkpoint | phase 3 |

Cloud vs on-prem K8s is the **same** `K8sBackend` — differences are config (kubeconfig/context/
registry/runtimeClass/namespace).

## Routing across many clusters (control plane)
**1 Backend instance = 1 target** (one Nomad endpoint / one kubeconfig context / one Windows pool).
Multiplicity lives in the control plane, not the Backend:

- `BackendRegistry` — a name → Backend map (e.g. `nomad-seoul`, `nomad-onprem`, `k8s-cloud`, `win-pool`).
- `Router(registry, defaultTarget)` — *static* placement: picks a backend per job from
  `evalCase.placement.target` (falling back to the default) and calls `dispatch`. Simple/dev.
- `Scheduler(registry, opts)` — *capacity-aware* placement (the SaaS control-plane path). Same
  `dispatch(job)` signature (drop-in `Dispatcher`), but it queries each backend's live `capacity()`
  and only dispatches where a slot is free; otherwise it **queues** and drains as slots free. See below.
- `buildRegistry(config)` — constructs the registry from a JSON config so the control plane can
  declare several backends at once.

```jsonc
// backends.config.json
{
  "default": "nomad-seoul",
  "backends": [
    { "name": "dev",         "kind": "local" },
    { "name": "nomad-seoul", "kind": "nomad", "addr": "http://nomad-seoul:4646", "image": "reg/assay-agent:1", "runtime": "runsc" },
    { "name": "nomad-onprem","kind": "nomad", "addr": "http://nomad-b:4646",     "image": "reg/assay-agent:1" }
  ]
}
```
```bash
pnpm assay run --backends-config backends.config.json --target nomad-onprem --task "..."
```
`EvalCase.placement` ({target, os?, isolation?}) is a control-plane hint — the **agent ignores it**.
(K8s/Windows backends register into the same registry once built; capability-based matching —
`{os, isolation}` instead of an explicit `target` — is a later enhancement.)

## Capacity-aware scheduling (SaaS, multi-tenant, elastic)
At SaaS scale many users submit many cases against finite/elastic infra, so placement must be
*capacity-aware*, not static. `Scheduler` is the placement layer that does this:

- **`Backend.capacity()` → `{total, used}`** — each backend reports its concurrent-slot budget.
  `LocalBackend`/`ServiceTopologyBackend` report a configured `maxConcurrent`; `NomadBackend`
  reports `maxConcurrent` and **live-probes** the cluster (`/v1/jobs?prefix=assay-`) for observed load.
- **placement** — for each queued job the scheduler computes `free = total − max(used, in-flight)`
  per eligible backend and picks one via a `PlacementPolicy`: `leastLoadedPolicy` (spread, default) or
  `binPackPolicy` (consolidate → enables scale-to-zero). `placement.target` is honored as a hard pin.
- **fair queue (multi-tenant)** — pending jobs are ordered by a **weighted fair queue** (`FairQueue`,
  WFQ) keyed by `AgentJob.tenant`, so one tenant's large batch can't starve another: each job gets a
  virtual-finish time `max(globalClock, tenantLastFinish) + 1/weight`, and the scheduler serves lowest
  first. Heavier `weightFor(tenant)` ⇒ served more often; an idle tenant can't hoard credit (the global
  virtual clock advances on every dequeue). `tenantQuota(tenant)` caps a tenant's concurrent in-flight
  runs even when slots are free.
- **queue + backpressure** — if no backend has a free slot (or the tenant is at quota) the job waits and
  is dispatched the moment a slot frees (a dispatch settling re-pumps the queue). `maxQueueDepth` rejects
  with `RateLimitError` (429) when the queue is saturated. The scheduler avoids head-of-line blocking by
  scanning the fair-ordered queue for the first placeable job.
- **wiring** — the Temporal `assay worker` builds a `Scheduler` over its registry (replacing `Router`),
  and `suiteWorkflow` fans out with a bounded lane count so a large suite can't flood activity slots;
  the scheduler then does fine-grained per-cluster capacity gating + tenant fairness on top.

```
N cases ─▶ Scheduler ─┬─ free slot? ─▶ dispatch to chosen backend (policy)
                      └─ none free  ─▶ queue ─▶ (slot frees) ─▶ pump ─▶ dispatch
```

Live proof:
- `scripts/live/scheduler-nomad.mjs` — submits N cases at once to a real `NomadBackend` capped at `CAP`;
  a poller confirms the cluster never runs more than `CAP` allocs concurrently while the rest queue/drain.
- `scripts/live/fair-scheduler-nomad.mjs` — tenant A submits 4, tenant B submits 1, `cap=1`; WFQ serves
  B at position 2 (FIFO would serve it last), proving no-starvation across tenants on real Nomad.

## Tenant isolation (trust zones)
Eval runs **untrusted code** — a tenant uploads its own harness image/code, which executes arbitrarily.
So multi-tenancy is a *security* boundary, not just fairness. A `TrustZone` (`@assay/core`) maps a tenant
to enforced isolation: `{isolationRuntime, namespace, network, trusted}`. A `TrustZonePolicy`
(`@assay/backends`) resolves `tenant → TrustZone`; `perTenantTrustZones()` is the safe default — **every
tenant gets its own zone** (hardened `runsc`, dedicated `assay-<tenant>` namespace, `deny-cross-tenant`,
`trusted:false`); `overrides`/`staticTrustZones` relax only declared first-party (`trusted`) tenants.

- **enforcement** — `assertHardenedIsolation(zone)` rejects an untrusted tenant on a shared-kernel runtime
  (`runc`/none); only `trusted` (first-party) zones may relax. `NomadBackend`/`ServiceTopologyBackend`
  apply this per dispatch, setting the docker `runtime` + Nomad `Namespace` from the resolved zone.
- **warm pools are NOT shared across tenants** — the single most important rule for service-topology
  harnesses. `NomadTopologyRuntime` keys its warm pool by `(spec.id, version, zone.id)` and suffixes the
  topology job ID with the zone, so two tenants on the same harness version get **separate** warm
  deployments (a shared LangGraph/agent process would leak state/secrets across tenants).

Live proof: `scripts/live/tenant-isolation-nomad.mjs` — the same `spec@version` for tenants `alpha` and
`beta` yields two distinct warm jobs (`assay-harness-…-alpha`, `…-beta`) on different endpoints, not a
shared pool. (gVisor `runsc` + Nomad namespaces are enforced in code + unit-tested; the dev cluster ships
only `runc`/no namespaces, so that live demo uses `trusted` zones — a real deployment needs runsc/namespaces.)

## Autoscaling (queue-depth driven)
Capacity-aware placement *queues* when full; the `Autoscaler` closes the loop by *adding capacity* when the
backlog grows and removing it when idle. It reads a `LoadSignal` (`{queued, inFlight}` from `Scheduler.stats()`
via `aggregateLoad`) each tick and drives `ScalingTarget`s:

- **decision** (`desiredCapacity`, pure) — `desired = clamp(inFlight + queued, min, max)`: provision enough
  slots to absorb the backlog, capped at `max` (the real infra ceiling); `min` may be `0` (scale-to-zero).
- **up fast, down slow** — upscale applies immediately (drain backlog); downscale only after
  `scaleDownAfterTicks` consecutive over-provisioned ticks (hysteresis ⇒ no flapping).
- **actuation** is abstracted by `ScalingTarget.scaleTo(n)`: `MutableSlots` (in-memory, drives a backend whose
  `maxConcurrent` is a getter — closes the loop end-to-end), or a callback to the **Nomad Autoscaler** / cloud
  ASG / K8s replica patch. After a scale the autoscaler calls `onChanged` → `Scheduler.poke()` to re-pump.

`Backend.capacity().total` reads a `maxConcurrent` that can be `number | (() => number)`, so the autoscaler's
slot changes take effect in the very next placement pass.

Live proof: `scripts/live/autoscaler-nomad.mjs` — 8 cases submitted at once with slots starting at 1; the
autoscaler scales 1→4 under backlog (peak 4 concurrent Nomad allocs, never above `MAX`) then back to 1 when idle.

## Per-tenant secrets & budgets
Two more multi-tenant guarantees, both keyed by `AgentJob.tenant`:

- **Secret scoping** (`SecretProvider`, `staticSecrets`) — each tenant's model keys (e.g. `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`) are injected into **only that tenant's** alloc env. `NomadBackend({secrets})`
  resolves `secretsFor(tenant)` per dispatch, so one tenant's key never lands in another's sandbox. (Returned
  maps are copies — no shared mutable secret state.)
- **Budgets** (`BudgetTracker`, `inMemoryBudget`) — per-tenant `{usd, tokens, runs}` limits enforced at the
  `Scheduler`. `dispatch` calls `budget.admit(tenant)` *before* queuing: over-limit ⇒ `PaymentRequiredError`
  (402, `BUDGET_EXCEEDED`). `runs` is **reserved at admit** so a burst of concurrent submits can't overshoot;
  `usd`/`tokens` are committed on completion via `settle(tenant, costOf(result))` (`sumCost` over the trace's
  `llm_call` costs) — a cost budget may be exceeded only by the single run that tips it over (cost is unknown
  until the run finishes).

Live proof: `scripts/live/budget-nomad.mjs` — tenant `free` capped at `runs=3`; submitting 5 at once runs exactly
3 and rejects 2 with `402 BUDGET_EXCEEDED`, while `acme`/`globex` jobs each carry only their own injected key.

Next slices: async API + result store (`apps/api` Fastify: run-id + webhook/polling + Postgres/ClickHouse),
`K8sTopologyRuntime` apply.

## Nomad (phase 1)
```bash
# 1) build + push the agent image to your internal registry
docker build -f packages/agent/Dockerfile -t <registry>/assay-agent:<tag> .

# 2) host: mint a subscription token, put it in assay/.env
claude setup-token            # → CLAUDE_CODE_OAUTH_TOKEN=...

# 3) run against your Nomad
pnpm assay run --backend nomad \
  --nomad-addr http://<nomad>:4646 \
  --image <registry>/assay-agent:<tag> --runtime runsc \
  --task "..." --test "..."
```
The control plane submits a batch job, polls the alloc to completion, and parses the
trace+scores from the alloc's stdout. `CLAUDE_CODE_OAUTH_TOKEN` is injected into the alloc env
→ **trusted / self-hosted Nomad only**.

> Isolation runtime (`--runtime runsc` for gVisor, or firecracker plugin, or none) depends on
> what your Nomad cluster has configured.
