---
kind: wiki
title: "Execution backends (Backend vs Driver)"
status: current
updated: 2026-09-16
anchors: [packages/backends/src/scheduling/scheduler.ts, packages/backends/src/placement/config.ts, packages/application-control/src/ops/scheduling-config.ts, apps/api/src/composition/trust-zones.ts, packages/application-control/src/require-runtime/require-runtime.ts]
---
# Execution backends (Backend vs Driver)

Two layers decide *where a harness run executes*:

- **Driver** (contract in `@everdict/contracts`, implementations in `@everdict/drivers`; in-sandbox compute):
  runs the harness as a subprocess INSIDE an already-isolated unit. The job-runner uses `LocalDriver`.
- **Backend** (`@everdict/backends`, placement): dispatches a job-runner job to an orchestrator
  and returns the `CaseResult`. Isolation is the orchestrator's job, not Everdict's.

## The job-runner (dispatched worker)
The control plane (outside the clusters) builds a `CaseJob` and hands it to a `Backend`:
`dispatch(job)` → runs `@everdict/job-runner` (`runCaseJob`) inside an isolated unit → the agent does
the whole case and prints the `CaseResult` on stdout behind the `__EVERDICT_RESULT__`
sentinel → the Backend parses it.

| Backend | Target | Isolation | Where it is used |
|---------|--------|-----------|------------------|
| `LocalBackend` | this host (in-process) | none | CLI (`everdict run`/`suite`), the CLI worker's default, a tenant `local` runtime |
| `NomadBackend` | Nomad (batch job, docker driver) | docker `runtime` (e.g. `runsc` = gVisor) + namespace | API global backend, tenant `nomad` runtimes, CLI |
| `K8sBackend` | Kubernetes (Job) | `runtimeClassName` (gVisor/Kata) + namespace | API global backend, tenant `k8s` runtimes, backends config (live on kind: `scripts/live/k8s-backend.mjs`) |
| `ServiceTopologyBackend` (`@everdict/topology`) | a nomad/k8s runtime with a `traceSource` | the runtime's, per trust zone | service (topology) harnesses — see `docs/service-harness.md` |
| `SelfHostedBackend` (`apps/api`) | a user's machine (`self:<id>`, `self:ws`) | the runner's own | self-hosted runners: the job parks until a runner leases it |
| `DockerBackend` | this host's docker daemon | the container | the deployment compute for held-open sessions and file runs when `EVERDICT_COMPUTE=docker` |

Cloud vs on-prem K8s is the **same** `K8sBackend` — differences are config (kubeconfig/context/
registry/runtimeClass/namespace). There is no Windows backend: a Windows target is a self-hosted runner, or
a registered runtime that declares the `os-windows` capability.

**Per-case timeout.** The run-context timeout is `EvalCase.timeoutSec` (int+positive, default 1800s; dataset
adapters set it from the task's own max-agent-timeout), passed by the job-runner into `runContextFromEnv` — so a
long agent case (a real ReAct loop = many sequential LLM calls) is honored instead of clipped. The
`EVERDICT_TIMEOUT_SEC` env var still overrides (operator escape hatch; a non-positive-integer value fails the
run). `everdict run` builds its case with `EVERDICT_TIMEOUT_SEC` or 300s.

**Model auth + endpoint injection.** `collectAuthEnv` forwards the harness's model auth/endpoint vars present in
the process env (`HARNESS_AUTH_ENV_VARS`): the claude vars (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`) **and** the OpenAI-compatible vars
(`OPENAI_API_KEY` / `OPENAI_BASE_URL`) — so a non-claude agent (aider/codex/a custom OpenAI-SDK agent) reaches
its gateway, not `api.openai.com`. In the API the tenant sets these as workspace secrets and the backend injects
that tenant's secrets into the job (see Per-tenant secrets below).

### The control-plane API never registers `LocalBackend` (default, no toggle)
`LocalBackend` runs the job **in-process on the control-plane host with no isolation** — fine for a
single-dev CLI, unacceptable for the control-plane API (untrusted eval code on the control plane). So the
API enforces this **by default — there is no opt-in env flag**:
- the global registry (`composition/execution-scheduling.ts`) **never registers** a `local` backend — at most
  one of `nomad` (`NOMAD_ADDR` + `EVERDICT_AGENT_IMAGE`) or `k8s` (`EVERDICT_K8S_CONTEXT` + image); otherwise it
  is empty and *every* job must route to a tenant runtime / self-hosted runner.
- `RunService.submit` and `ScorecardService.submit` **reject at submit time (400)** any run/scorecard with no
  execution target — i.e. no `runtime` (a registered tenant `RuntimeSpec` id) and no `self:<id>`/`self:ws`
  self-hosted target. Fail-fast (`assertRuntimeTarget`, `require-runtime.ts`), so there is **no silent fallback
  to in-process host execution**. Target *validity* (does the runtime/runner exist) is still checked later by
  `RuntimeDispatcher`/`Scheduler` (`NOT_FOUND`); the submit gate only enforces that a target was chosen. The
  API composition (`composition/run.ts`, `composition/scorecard.ts`) sets `requireRuntime: true`
  unconditionally; the flag exists only so mock-dispatcher unit tests, which bypass the backend layer, stay valid.
- A tenant CAN register a `RuntimeSpec` of kind `local`, and `buildRuntimeBackend` builds a `LocalBackend` for
  it — the policy above covers the global registry and the no-target fallback, not that kind.

Need in-process single-host execution for dev? Use `apps/cli` (`everdict run`), which owns `LocalBackend` — the
API is for managed / remote (runtime / self-hosted) execution.

## Routing across many clusters (control plane)
**1 Backend instance = 1 target** (one Nomad endpoint / one kubeconfig context).
Multiplicity lives in the control plane, not the Backend:

- `BackendRegistry` — a name → Backend map (e.g. `nomad-seoul`, `nomad-onprem`, `k8s-cloud`).
- `Router(registry, defaultTarget)` — *static* placement: picks a backend per job from
  `evalCase.placement.target` (falling back to the default) and calls `dispatch`. The CLI's direct mode.
- `Scheduler(registry, opts)` — *capacity-aware* placement (the API and the Temporal worker). Same
  `dispatch(job)` signature (drop-in `Dispatcher`), but it queries each backend's live `capacity()`
  and only dispatches where a slot is free; otherwise it **queues** and drains as slots free. See below.
- `buildRegistry(config)` — constructs the registry from a JSON config (kinds `local` / `nomad` / `k8s`) so
  the CLI and the worker can declare several backends at once.

```jsonc
// backends.config.json
{
  "default": "nomad-seoul",
  "backends": [
    { "name": "dev",         "kind": "local" },
    { "name": "nomad-seoul", "kind": "nomad", "addr": "http://nomad-seoul:4646", "image": "reg/everdict-job-runner:1", "runtime": "runsc" },
    { "name": "nomad-onprem","kind": "nomad", "addr": "http://nomad-b:4646",     "image": "reg/everdict-job-runner:1" },
    { "name": "k8s-cloud",   "kind": "k8s",   "image": "reg/everdict-job-runner:1", "context": "cloud", "runtimeClass": "gvisor" }
  ]
}
```
```bash
pnpm everdict run --backends-config backends.config.json --target nomad-onprem --task "..."
```
`EvalCase.placement` ({target, os?, isolation?}) is a control-plane hint — the **agent ignores it**. `target`
chooses the backend; `os` and `isolation` become required capabilities that gate the chosen runtime
(`runtimeSatisfies` in `RuntimeDispatcher` — a runtime that declared no capabilities is unchecked). They do not
pick a target.

## Capacity-aware scheduling (SaaS, multi-tenant, elastic)
At SaaS scale many users submit many cases against finite/elastic infra, so placement must be
*capacity-aware*, not static. `Scheduler` is the placement layer that does this:

- **`Backend.capacity()` → `{total, used}`** — each backend reports its concurrent-slot budget.
  `LocalBackend`/`DockerBackend`/`SelfHostedBackend` report a configured count; `NomadBackend` **live-probes**
  the cluster (`/v1/jobs?prefix=everdict-&namespace=*`) and `K8sBackend` its active jobs; `ServiceTopologyBackend`
  derives capacity from the topology's session pool, clamped by `maxConcurrent`. A probe that cannot count
  reports `used: "unknown"`, which the scheduler spends as no room.
- **placement** — for each queued job the scheduler computes `free = total − max(used, in-flight)`
  per eligible backend and picks one via a `PlacementPolicy` — `leastLoadedPolicy` (spread) is the default
  and the only one shipped. `placement.target` is honored as a hard pin.
- **fair queue (multi-tenant)** — pending jobs are ordered by a **weighted fair queue** (`FairQueue`,
  `@everdict/domain`) keyed by `CaseJob.tenant`, so one tenant's large batch can't starve another: each job gets a
  virtual-finish time `max(globalClock, tenantLastFinish) + 1/weight`, and the scheduler serves lowest
  first. Heavier `weightFor(tenant)` ⇒ served more often; an idle tenant can't hoard credit (the global
  virtual clock advances on every dequeue). `tenantQuota(tenant)` caps a tenant's concurrent in-flight
  runs even when slots are free.
- **the tenant quota is fleet-wide** — a quota bounds a WORKSPACE, so counting it from one process's map
  would hand it out once per control-plane replica. The optional `AdmissionLedger` (the `RunStore`) closes that
  in two steps: `inFlightByTenant()` is read once per drain (`running`, eval-family, non-session rows) as a
  best-effort pre-filter that falls back to this process's counts when the ledger cannot answer; then
  `tryAdmit(tenant, permitId, quota)` claims an ATOMIC fleet-wide permit (a per-tenant counter row on Postgres),
  fail-closed on a ledger error, released at settle and renewed as a lease while the work runs. Absent
  (single-process dev, the CLI worker) ⇒ per-process counts only. Backend slots/memory/cpu fold the
  orchestrator probe's observed reading with this process's in-flight the same `max` way. See
  `docs/architecture/multi-replica.md`.
- **queue + backpressure** — if no backend has a free slot (or the tenant is at quota) the job waits and
  is dispatched the moment a slot frees (a dispatch settling re-pumps the queue). `maxQueueDepth` and the
  per-tenant queue depth reject with `RateLimitError` (429) when saturated. The scheduler avoids head-of-line
  blocking by scanning the fair-ordered queue for the first placeable job.
- **priority classes** — `CaseJob.priority`: `"interactive"` (a person is waiting — single runs) is scanned
  before `"batch"` (scorecard fan-out), with WFQ order preserved WITHIN each class, so a 3-case check never
  sits behind a 601-case batch. `RunService` stamps interactive; the batch drivers stamp batch; absent =
  batch-equivalent.
- **resource-aware admission** — a runtime may declare an envelope (`RuntimeSpec.maxConcurrent` +
  `memoryBudgetMb`/`cpuBudget` → `BackendCapacity`); the scheduler tracks in-flight harness-declared
  memory (`resources.memoryMb`) AND cpu (`resources.cpu`, 1000 = 1 vCPU) per backend and admits a heavy
  job only where both fit. Undeclared harnesses stay outside the budgets (opt-in by declaring). See
  `docs/architecture/batch-resilience.md`.
- **operator dials (env)** — `EVERDICT_TENANT_QUOTAS="acme=8,*=16"` / `EVERDICT_TENANT_WEIGHTS="acme=3,*=1"`
  feed `tenantQuota`/`weightFor` (parsed by `scheduling-config.ts` in `@everdict/application-control`; `*` =
  default for unlisted tenants; quotas must be positive integers, weights positive numbers; malformed entries
  fail the boot loudly). Unset = unlimited quota, weight 1 — the machinery is always on; these are just the
  dials. Cross-tenant fairness is operator-set, not workspace self-serve.
  `EVERDICT_TENANT_QUEUE_DEPTHS="acme=200,*=1000"` caps a tenant's **queued** entries (over-cap submit =
  429 `RATE_LIMITED`, never a silent drop) so one tenant's burst can't consume unbounded queue memory.
  `EVERDICT_MAX_QUEUE_DEPTH` (default 10000) is the GLOBAL backstop over the whole queue; beyond it dispatch
  rejects 429. Malformed = boot failure (a typo must not mean "unlimited").
  Quota/weight can also be adjusted **without a restart** via `PUT /internal/scheduling`
  (`{"quotas":{"acme":2,"beta":null},"weights":{…}}`, `null` clears an override; `GET` returns the
  effective view) — an in-memory override layer on top of the env defaults, guarded like every `/internal/**`
  route by `x-internal-token`. A restart falls back to env.
- **adaptive batch width** — `EVERDICT_QUEUE_PRESSURE` (default 64): scheduler queue depth above which a
  running batch halves its effective dispatch concurrency (see `docs/architecture/batch-resilience.md`,
  Adaptive batch concurrency). Open runtime circuits halve it too; both signals self-restore.
- **queue aging (anti-starvation)** — a queued entry waiting past `agingMs` (default 60 s) is promoted
  into the urgent scan class alongside `priority: "interactive"` jobs, so heavy WFQ weights/quotas can
  delay a tenant's batch work but never starve it indefinitely.
- **wiring** — the Temporal `everdict worker` builds a `Scheduler` over its registry, so its `dispatchCase`
  activity gets per-cluster capacity gating + tenant fairness (see `docs/orchestration.md`).

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
So multi-tenancy is a *security* boundary, not just fairness. A `TrustZone` (`@everdict/contracts`) maps a tenant
to enforced isolation: `{id, isolationRuntime, namespace?, network, trusted, storeIsolation?}`. A
`TrustZonePolicy` (`@everdict/domain`) resolves `tenant → TrustZone`; `perTenantTrustZones()` is the safe
policy — **every tenant gets its own zone** (hardened `runsc`, dedicated `everdict-<tenant>` namespace,
`deny-cross-tenant`, `trusted:false`); `overrides`/`staticTrustZones` relax only declared first-party
(`trusted`) tenants.

- **enforcement** — `assertHardenedIsolation(zone)` (`@everdict/domain`) rejects an untrusted tenant on a
  shared-kernel runtime (e.g. `runc`; hardened = gVisor, Kata or Firecracker names); only `trusted` (first-party)
  zones may relax. `NomadBackend`, `K8sBackend`, `ServiceTopologyBackend` and the sandbox lane apply it per
  dispatch, taking the runtime + namespace from the resolved zone.
- **the policy is the OPERATOR's, and the control plane says which one is live** —
  `EVERDICT_TRUST_ZONES` (`apps/api` `composition/trust-zones.ts`) selects it, and the choice is printed at
  boot:
  - `runtime-declared` (default) — a dispatch is isolated by what its own `RuntimeSpec` declares
    (`spec.runtime` / `spec.namespace` / `spec.runtimeClass`). Legitimate for a single-tenant cluster the
    operator already hardened; **not** per-tenant enforcement.
  - `per-tenant` — `perTenantTrustZones()` over every dispatch (`EVERDICT_TRUST_ZONE_RUNTIME`,
    `EVERDICT_TRUST_ZONE_NAMESPACE_PREFIX` tune it). Has a **prerequisite**: the hardened runtime must be
    installed on the clients and the namespaces must exist, or every job fails — which is why it cannot be
    switched on for an operator by default.
  An unrecognized value **fails the boot** rather than degrading to the permissive default: an isolation
  setting nobody honors is worse than one that refuses to start. The same policy object reaches the global
  backends, tenant runtimes, topology backends and the sandbox lane.
- **warm pools are NOT shared across tenants** — the single most important rule for service-topology
  harnesses. `NomadTopologyRuntime` keys its warm pool by `id@version@zone` and names the topology job
  `everdict-harness-<id>-<version>-<zone>`, so two tenants on the same harness version get **separate** warm
  deployments (a shared LangGraph/agent process would leak state/secrets across tenants).

Live proof: `scripts/live/tenant-isolation-nomad.mjs` — the same `spec@version` for tenants `alpha` and
`beta` yields two distinct warm jobs (`…-alpha`, `…-beta`) on different endpoints, not a shared pool. The demo
uses `trusted` `runc` zones because its dev cluster has no gVisor or namespaces; `runsc` + namespaces are
enforced in code and unit-tested.

## Autoscaling (queue-depth driven)
Capacity-aware placement *queues* when full; the `Autoscaler` (`@everdict/domain`) closes the loop by *adding
capacity* when the backlog grows and removing it when idle. It reads a `LoadSignal` (`{queued, inFlight}`, e.g.
from `Scheduler.stats()` via `aggregateLoad`) each tick and drives `ScalingTarget`s:

- **decision** (`desiredCapacity`, pure) — `desired = clamp(inFlight + queued, min, max)`: provision enough
  slots to absorb the backlog, capped at `max` (the real infra ceiling); `min` may be `0` (scale-to-zero).
- **up fast, down slow** — upscale applies immediately (drain backlog); downscale only after
  `scaleDownAfterTicks` (default 3) consecutive over-provisioned ticks (hysteresis ⇒ no flapping).
- **actuation** is abstracted by `ScalingTarget.scaleTo(n)`; the implementation in the repository is
  `MutableSlots` (in-memory, drives a backend whose `maxConcurrent` is a getter). After a scale the autoscaler
  calls `onChanged` → `Scheduler.poke()` to re-pump.
- **API wiring** — `EVERDICT_AUTOSCALE="min:max[:intervalMs]"` autoscales the global env backends
  (`nomad`/`k8s`) only; tenant runtimes keep their spec-declared envelope. Malformed = boot failure.

`Backend.capacity().total` reads a `maxConcurrent` that can be `number | (() => number)`, so the autoscaler's
slot changes take effect in the very next placement pass.

Live proof: `scripts/live/autoscaler-nomad.mjs` — 8 cases submitted at once with slots starting at 1; the
autoscaler scales 1→4 under backlog (never above `MAX`) then back to 1 when idle.

## Per-tenant secrets & budgets
Two more multi-tenant guarantees, both keyed by `CaseJob.tenant`:

- **Secret scoping** (`SecretProvider`, `staticSecrets`) — each tenant's model keys (e.g. `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`) are injected into **only that tenant's** job env. `NomadBackend({secrets})` /
  `K8sBackend({secrets})` resolve `secretsFor(tenant)` per dispatch (the API backs it with the workspace
  `SecretStore`), so one tenant's key never lands in another's sandbox; `secretEnv` is the fallback when no
  provider is set. Cluster credentials (`authSecret`, `kubeconfigSecret`) are stripped from the job env.
- **Budgets** (`BudgetTracker`, `inMemoryBudget`, `@everdict/domain`) — per-tenant `{usd, tokens, runs}` limits.
  `admit(tenant)` throws `PaymentRequiredError` (402, `BUDGET_EXCEEDED`) and reserves one run, so a burst of
  concurrent submits can't overshoot; `usd`/`tokens` are committed on completion via `settle(tenant, cost)`
  (`sumCost` over the trace's `llm_call` costs) — a cost budget may be exceeded only by the single run that tips
  it over (cost is unknown until the run finishes). `Scheduler({budget})` admits before queuing and settles on
  completion; the API instead admits at submit (`RunService.submit`, the batch drivers, sessions) against a
  persistent budget (per-tenant limits from the DB, `EVERDICT_TENANT_RUNS` / `EVERDICT_TENANT_USD` as the env
  fallback) and settles each execution's cost.

Live proof: [`budget-nomad.mjs`](https://github.com/everdict/everdict/blob/32879892f/scripts/live/budget-nomad.mjs) — tenant `free` capped at `runs=3`; submitting 5 at once runs exactly
3 and rejects 2 with `402 BUDGET_EXCEEDED`, while `acme`/`globex` jobs each carry only their own injected key.

## Nomad from the CLI
```bash
# 1) build + push the job-runner image to your internal registry
docker build -f packages/job-runner/Dockerfile -t <registry>/everdict-job-runner:<tag> .

# 2) host: mint a subscription token, put it in everdict/.env
claude setup-token            # → CLAUDE_CODE_OAUTH_TOKEN=...

# 3) run against your Nomad
pnpm everdict run --backend nomad \
  --nomad-addr http://<nomad>:4646 \
  --image <registry>/everdict-job-runner:<tag> --runtime runsc \
  --task "..." --test "..."
```
`--nomad-addr`/`--image` fall back to `NOMAD_ADDR`/`EVERDICT_AGENT_IMAGE`. The CLI submits a batch job, polls
the alloc to completion, and parses the result from the alloc's stdout. `CLAUDE_CODE_OAUTH_TOKEN` is injected
into the alloc env → **trusted / self-hosted Nomad only**.

> Isolation runtime (`--runtime runsc` for gVisor, or firecracker plugin, or none) depends on
> what your Nomad cluster has configured.
