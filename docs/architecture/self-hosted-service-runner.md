# Self-hosted runner — drive *service* (topology) harnesses on your own machine (design)

> **Status: design (doc-first). Three decisions locked with the user; implementation in slices.**
> - **D1 — local topology = a new `DockerTopologyRuntime`.** Deploy the topology (services + dependency stores +
>   per-case browser) on the **user's Docker daemon** — the orchestrator-agnostic sibling of
>   `NomadTopologyRuntime` / `K8sTopologyRuntime`. `ServiceTopologyBackend` is untouched (the dispatch-a-worker split preserved).
> - **D2 — doc-first → slices.** `DockerTopologyRuntime` → runner kind-branch → capability gating + routing.
> - **D3 — trace degrades to snapshot.** No local OTel/MLflow required — the topology already records a trace-fetch
>   failure as one `error` event and grades on the browser snapshot. A local collector is optional (non-goal here).
>
> Extends [self-hosted-runner.md](./self-hosted-runner.md) (SHIPPED — process/command harnesses on a personal host)
> to its missing harness class. Like [judge-placement-locality](./judge-placement-locality.md) /
> [front-door-generalization](./front-door-generalization.md): **strict generalization, not a clean break** — the
> runner's existing `runCaseJob` path is unchanged; service harnesses take a new branch; absence of Docker just
> means the runner declines service jobs.

## Problem

The self-hosted runner lets a member run a **workspace** harness/dataset on **their own machine** by changing only
the runtime (`self:<runnerId>`). But it only handles **process/command** harnesses: its unit of work is
`runCaseJob(job)` → `runCase` over `LocalDriver`. A **`kind:"service"` topology harness** (multi-service + a
target browser, e.g. browser-use) is driven by a *different* path — `ServiceTopologyBackend` holding a
`TopologyRuntime` (Nomad/K8s) — which the runner has no access to. So "run it on my laptop" works for SWE-bench /
aider but **not** for a service topology.

## Current state — verified

- **Runner unit of work is process-only.** `runCaseJob` (`packages/job-runner/src/run.ts:13`) picks the environment by
  `evalCase.env.kind` (prompt / os-use / repo) and runs over `LocalDriver`. `run.ts:25` is explicit:
  *"browser topology is handled by ServiceTopologyBackend — outside this local path"* (topology is **outside** this local path).
- **The CLI runner never branches.** `runnerCommand` (`apps/cli/src/main.ts:204`) leases a job, `CaseJobSchema`-
  parses it, and unconditionally calls `runCaseJob(parsed.data)` (`main.ts:272`). A service job would be mis-run.
- **No local topology runtime exists.** `TopologyRuntime` has exactly two impls — `NomadTopologyRuntime`
  (`nomad-runtime.ts:109`) and `K8sTopologyRuntime` (`k8s-runtime.ts:43`). Both need a *cluster*. There is no way
  to stand a topology up on a laptop's Docker daemon.
- **The seam already fits.** `ServiceTopologyBackend` (`service-backend.ts`) is orchestrator-AGNOSTIC — it takes a
  `TopologyRuntime` + `traceSource` + `specFor` and does ensure→drive→observe→grade. A third runtime drops in with
  **no backend change**. `STORE_DEFS` (`dependencies.ts`, image/port/`connEnv`) and the per-run wiring
  (`wiringVars`) are orchestrator-agnostic and reused as-is. `DockerBackend` (`docker-backend.ts:32`) shows the
  `execFile("docker", …)` adapter pattern (probe = `docker version`).
- **The job already carries what's needed.** `CaseJob.harnessSpec` is the **resolved** `HarnessSpec` (incl.
  `kind:"service"` with `services`/`dependencies`/`target`/`frontDoor`/`traceSource`), Zod-validated at the MCP
  lease boundary — the runner can read `kind` and the full topology from the leased job.

## Direction — three decisions

The dispatch-a-worker insight one level out: the runner **is the user's "cluster."** Today its placement layer is
`runCaseJob` (in-process). For topologies it needs a *topology placement* on the same machine — that's
`DockerTopologyRuntime`. The runner picks the path by harness kind; everything downstream is the existing
orchestrator-agnostic machinery.

| # | Decision | Shape |
| --- | --- | --- |
| D1 | **Local topology** | `DockerTopologyRuntime` (`@everdict/topology`) — deploy on the user's Docker daemon; sibling of Nomad/K8s |
| D2 | **Runner branch** | CLI: `harnessSpec.kind === "service"` → `ServiceTopologyBackend(DockerTopologyRuntime)`; else `runCaseJob` |
| D3 | **Trace** | degrade-to-snapshot (no local OTel/MLflow needed); the topology's existing trace-fetch guard handles it |

### `DockerTopologyRuntime` (D1)
Implements `TopologyRuntime` against `docker` (via a thin injectable `Docker` adapter — `run`/`port`/`rm`/`network`,
default `execFile("docker", …)`, faked in unit tests like `Kubectl`):
- **`ensureTopology(spec)`** — create a per-topology docker network; for each `spec.dependencies` store, `docker run -d`
  its `STORE_DEFS` image with a published port, discover `host:port` (`docker port`), build `connEnv`; for each
  `spec.services`, `docker run -d` the image on the network with store env + per-run wiring, publish its `port`,
  discover the endpoint, wait for HTTP ready → `TopologyHandle{ endpoints }`. **Warm pool keyed by `id@version`**
  (no `TrustZone` — a personal host is a single trust domain; isolation is the **user's** concern, so **no**
  `assertHardenedIsolation`/gVisor and **no** pool/silo per-tenant store isolation — see Non-goals).
- **`provisionBrowserEnv(spec, runId)`** — `docker run -d` headless Chromium (`chromedp/headless-shell`, publish
  9222), discover the CDP `host:port` → `cdpUrl`; `snapshot()` via CDP `/json/list` (mirrors `k8s-runtime` snapshot);
  `dispose()` = `docker rm -f` the browser only (warm topology survives).
- **`teardown()`** — remove the topology's containers + network.

### Runner kind-branch (D2)
Extract a single `runLeasedJob(job)` (shared by `everdict runner`) that branches once:
```ts
if (job.harnessSpec?.kind === "service") {
  const backend = new ServiceTopologyBackend({
    runtime: new DockerTopologyRuntime(),
    traceSource: buildTraceSource(job.harnessSpec.traceSource),  // @everdict/trace
    specFor: () => job.harnessSpec,                              // the leased resolved spec
    // no trustZones (personal host); submit/getJson default to fetch
  });
  return backend.dispatch(job);
}
return runCaseJob(job);                                          // process/command (today)
```
`apps/cli` gains `@everdict/topology` + `@everdict/trace` deps (it already has `@everdict/job-runner`/`@everdict/backends`).

### Capabilities + routing (D2 cont.)
The runner already declares `capabilities[]` (`self-hosted-runner.md` D-model: `repo`/`browser`/`os-use`/`docker`).
- The runner probes Docker on start (`docker version`) and advertises `docker`+`browser` only when present.
- `lease_job` hands a **service** job only to a runner whose capabilities include `docker`+`browser` (a process-only
  runner never leases a topology it can't run — it parks/repeats). Double-sided as today (owner-scoped queue).
- Confirm the control plane lets a service harness pin to `self:<runnerId>` (the job already routes via
  `SelfHostedBackend`; the gate is purely on the lease/capability side).

## Slices (sequencing — each merges independently)

1. ✅ **`DockerTopologyRuntime`** (`@everdict/topology`) — DONE. `docker.ts` (injectable `Docker` adapter +
   `dockerCli()` default + pure `dockerRunArgs`/`parseHostPort`) + `docker-runtime.ts` (`DockerTopologyRuntime`):
   `ensureTopology` (network → dependency stores [`--network-alias <id>-<store>` matching `dependencyConnEnv`, store
   readiness via `docker exec` pg_isready/redis-ping] → services [`--network-alias <name>`, publish port, discover
   host port → endpoint], warm-pool keyed by `id@version`), `provisionBrowserEnv` (headless-shell, `cdpUrl` = the
   **internal** alias for the agent, `snapshot()` via the **host** published port), `dispose`/`teardown`. No
   `TrustZone`/pool-silo (single-user host). Deterministic tests with a fake Docker (100/100 topology, +6). No
   runner/CLI change yet — backend-constructible in isolation. Host↔container CDP address nuance is a live-e2e
   (slice 3) concern.
2. ✅ **Runner kind-branch** — DONE. `packages/self-hosted-runner/src/run-leased-job.ts` (extracted from `apps/cli`) `runLeasedJob(job)`: `harnessSpec.kind ===
   "service"` → `ServiceTopologyBackend({ runtime: new DockerTopologyRuntime(), traceSource:
   buildTraceSource(spec.traceSource), specFor: () => spec })` (no trustZones; submit/getJson default fetch); else
   `runCaseJob` (absent `harnessSpec` ⇒ process path = today). The runner loop (`main.ts:273`) calls it instead of
   `runCaseJob`. `apps/cli` gains `@everdict/topology` + `@everdict/trace` deps. Injectable `runService`/`runProcess` →
   daemon-free unit test of the branch (3 cases). cli build + 3/3 test + full turbo build 20/20 green.
3. ✅ **Capabilities + routing — DONE (code + live e2e).** Auto-advertise: the CLI runner probes
   `docker version` on start → `capabilities = ["repo", ...(docker ? ["docker","browser"] : [])]`, reported on every
   `lease_job` (new optional `capabilities` param → `RunnerService.setCapabilities` → `RunnerStore.setCapabilities`,
   filtered to `RUNNER_CAPABILITIES`). **Gate at dispatch (not lease — jobs are pinned to one runner):**
   `resolveSelfRunner` now returns the runner's `capabilities` (undefined = not owned → 404); the `RuntimeDispatcher`
   `self:` branch rejects a `harnessSpec.kind === "service"` job on a runner lacking `docker` with an explicit
   `BadRequest` (blocked before it would fail at `docker run`). Tests: runtime-dispatcher +2 (no-docker → 400 /
   docker → routed), runner-store `setCapabilities`, api 239 / db / cli build green. **Remaining (manual, needs a
   Docker daemon + a real service-harness image): the live round-trip** — pair a runner, `everdict runner`, submit a
   scorecard with a service harness pinned to `self:<runner>`, assert snapshot-graded result back (trace degraded).
   Tracked like the repo's other live-infra-blocked validations.
   **Live e2e PASS** (`scripts/live/self-hosted-service-runner.mjs`): pair → `everdict runner` (docker
   auto-advertised on lease) → register a one-service harness (stub front door, dead traceSource) → run pinned
   to `self:<runner>` → the topology container stood up in local Docker (readiness GET + `POST /runs` with
   per-run wiring visible in its logs), the trace degraded as designed, and the result landed with
   `provenance.ranOn=self-hosted`.

## Follow-up — adopt-don't-kill (cross-process container collision)

`DockerTopologyRuntime`'s names are deterministic (`everdict-<id>-<version>-<svc>`), which the
"idempotent redeploy" `docker rm -f` relied on. But two runner PROCESSES on the same host (e.g. the
desktop app plus a CLI runner) running the same harness version reach the SAME names — the second
process's cleanup killed the first's live topology mid-run. Fix: `deploy` first gates on
`Docker.running(names)` (exact-name intersection over `docker ps`) and, when the full set is running,
one-shot-probes it (store `pg_isready`/`redis-cli ping` + ported-service HTTP) — a healthy topology is
**adopted** into the warm pool (endpoints rediscovered via `docker port`) instead of removed; anything
partial or unready still takes the rm+redeploy path. Residual race: probing a topology that another
process is mid-deploying fails the probe and redeploys over it (converges — the loser's deploy fails,
its retry adopts); a true cross-process lock stays a non-goal on a personal host.

## Non-goals (this pass)

- **No per-tenant store isolation (pool/silo) on the personal host.** A self-hosted runner is one user's machine =
  one trust domain; the workspace cluster runtimes keep their `TrustZone` model. (`DockerTopologyRuntime` runs a
  simple per-topology store; per-run logical isolation via the existing `isolateBy` wiring still applies.)
- **No hardened isolation (gVisor/Kata).** Isolation on a user's own host is the user's concern (the same D-decision
  as the base self-hosted runner; the run executes *as the user*).
- **No local trace-collector management.** Trace degrades to the browser snapshot (D3); a runner-managed local
  OTel/MLflow is a later, optional enhancement.

## Touch points (per slice)

- `packages/topology/src/deploy/docker-runtime.ts` — **new**: `DockerTopologyRuntime` + injectable `Docker` adapter
  (slice 1); barrel export in `index.ts`.
- `packages/topology/src/docker-topology.ts` — **new (if needed)**: pure docker-arg builders (deterministic-tested),
  mirroring `nomad-topology.ts`/`k8s-topology.ts`.
- `apps/cli/src/main.ts` — `runLeasedJob` kind-branch (slice 2); `apps/cli/package.json` deps (`@everdict/topology`,
  `@everdict/trace`).
- `apps/api/src/runners/runner-hub.ts` / `mcp.ts` — `lease_job` capability gating for service jobs (slice 3).
- Docs/skill: `docs/architecture/self-hosted-runner.md` (link this extension) + the `topology` skill reference
  (the third `TopologyRuntime`) travel with the change.
