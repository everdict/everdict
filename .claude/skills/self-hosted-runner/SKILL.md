---
name: self-hosted-runner
description: Self-hosted runners + the runtime/capability model — packages/self-hosted-runner (MCP lease loop, capability probes), personal/workspace runner tiers, RuntimeSpec. Use when editing self-hosted-runner, the capability model, RuntimeSpec, or self-hosted execution.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Self-hosted runners (runtime + capability model)

Design SSOT: `docs/architecture/self-hosted-runtime-and-runners.md`. **Runtime = WHERE** (an
environment/pool a job targets; self-hosted included — "my machine" IS a self-hosted runtime, no
separate "device" layer). **Runner = the worker process** that joins a runtime, leases one job at a
time, runs it, reports back — **N runners = N concurrent jobs**. Both Everdict runners and GitHub Actions
runners are workers co-resident on one self-hosted host. `packages/self-hosted-runner` is the GUI-free,
transport-injectable core shared by `apps/cli` + `apps/desktop` (desktop shell = skill `desktop`).

## Checklist
1. Read the SSOT doc first. Runner behavior changes go in `packages/self-hosted-runner` ONLY (CLI + desktop stay identical) — never fork logic into `apps/cli` or `apps/desktop`.
2. Capability vocab is one SSOT (`packages/core/src/infra/capability.ts`) — add a capability = one line in `CAPABILITY_DEFS`; its `kind` auto-routes advertise/match/enforce.
3. Runners self-advertise via probes (`detectCapabilities`), never user input. Add a probe to `defaultProbes` when you add a functional capability.
4. Placement gates on **functional** caps only (`functionalGate`); security→trust-zone, auth→budget. Never gate placement on a security/auth cap.
5. Boundary-validate every leased job with `CaseJobSchema`; release the MCP session in `finally`.
6. Gates: `pnpm format`(scoped) → `lint` → `typecheck` → `test` → `build` green before commit.

## self-hosted-runner (the lease loop)
- `runLeaseWorkers` (`packages/self-hosted-runner/src/runner-loop.ts`) — `maxConcurrent` worker loops over ONE MCP session; each does `lease_job` → `runJob` → `submit_job_result`/`fail_job`, with a `heartbeat_job` interval refreshing the lease. `RunnerLoopDeps` is DI (callJson/runJob injected). Server `RunnerHub.lease` is single-thread-atomic → concurrent leases never double-hand a job.
- **Version handshake (D13)**: every `lease_job` self-reports `protocol: RUNNER_PROTOCOL_VERSION` (`@everdict/contracts`, bumped only on a breaking runner-contract change) + an optional display `version` (`RunnerLoopOpts.version`, host-injected — desktop passes `app.getVersion()`). The control plane compares protocols and replies `updateRequired:true` when the runner is behind; the loop fires `RunnerLoopDeps.onUpdateRequired` **once per session** (GUI-free — the desktop wires it to a forced auto-update check; headless surfaces a roster badge via `RunnerMeta.updateRequired`). `RunnerService.reportVersion` persists it (mig 0062); `runnerUpdateRequired` derives the badge. A no-protocol (pre-D13) runner is never flagged.
- `ResilientMcpSession` + `mcpConnect` (`packages/self-hosted-runner/src/runner-session.ts`) — auto re-initializes a dead MCP session (API restart drops the in-memory session id) and retries the call once; app-level `isError` results do NOT trigger reconnect.
- `runLeasedJob` (`packages/self-hosted-runner/src/run-leased-job.ts`) — branches by harness kind: `service` → local Docker topology (`ServiceTopologyBackend` over a lazy-singleton `sharedTopologyRuntime`, so the warm-pool survives across cases) / else → `runCaseJob`. A non-service case with `case.image` + the `docker` capability runs in a local container (`DockerDriver`, `packages/drivers/src/docker.ts`) — same path as managed `DockerBackend`, so one definition runs managed OR local (portable-harness).
- `RunnerHost` (`packages/self-hosted-runner/src/runner-host.ts`) — GUI facade wrapping the loop for the desktop main process; CLI uses `runLeaseWorkers` directly.
- `detectCapabilities`/`defaultProbes` (`packages/self-hosted-runner/src/capabilities.ts`) — probes THIS machine (git/docker/browser/computer-use/sandbox/codex-login/claude-login); `topology` has no local probe (derived, gated by `docker`).

## Capability model (`packages/core/src/infra/capability.ts`)
`CAPABILITY_DEFS` = the vocab SSOT; each name → a `kind` that decides HOW it is matched:
- **functional** (`git·docker·browser·computer-use·topology`) → **placement gate** (`functionalGate`/`runtimeSatisfies`: required ⊆ advertised).
- **security** (`sandbox`) → **trust-zone** enforces (`assertHardenedIsolation`); the label is a hint, **not** enforcement.
- **auth** (`codex-login·claude-login`) → **budget** (own-pays: the machine's own login, workspace budget untouched).
`partitionCapabilities` splits requirements by kind → each kind routes to its own layer. `requiredCapabilities(evalCase)` derives a case's needs (image→docker, git source→git, browser/os-use env, isolation→sandbox); `defaultRuntimeCapabilities(spec)` auto-labels a registered runtime (both in `packages/core/src/infra/capability-requirements.ts`).

## Runtime = WHERE (`packages/core/src/infra/runtime-spec.ts`)
Registered `RuntimeSpec` kinds are **`local | nomad | k8s`** only. The `docker` and `topology` KINDS were removed (slice 5b): "single docker host" → the self-hosted runner's local docker (the `docker` capability), and topology → a `nomad|k8s` runtime carrying `traceSource` (the `topology` capability). `local` = control-plane host, dev-only. `authSecret`/`kubeconfigSecret` name a SecretStore key (never the value; stripped from alloc env).

## Tiers, pairing, dispatch (apps/api)
- Pairing token `rnr_` (desktop `safeStorage`, or CLI `--pair`) → `runnerAuthenticator` maps it to `Principal{via:"runner"}` (`packages/auth/src/runner.ts`). Pair via `RunnerService.pair`/`pairWorkspace` (`apps/api/src/runners/runner-service.ts`).
- Targets (`runtime` selector → `placement.target`), routed by `RuntimeDispatcher` (`apps/api/src/execution/runtime-dispatcher.ts`):
  - `self:<id>` — a personal-owned runner (owner=submitter, **owner-checked**, own-pays).
  - `self` — the personal pool (any of my runners; own-pays).
  - `self:ws:<id>` / `self:ws` — a workspace-shared runner / pool (owner=`ws:<tenant>` **derived from the job tenant** → membership IS access, cross-workspace structurally impossible; workspace-pays via `billingTenant`, `packages/backends/src/budget.ts`).
- `RunnerHub` (`apps/api/src/runners/runner-hub.ts`) — the lease queue; `POOL_RUNNER="*"` sentinel + `poolKeyFor(owner)` route pool jobs (a capability mismatch on the pool is **skipped**, not rejected, so a capable runner takes it); `requiredRunnerCapabilities(job)` adds `docker` for service harnesses. `SelfHostedBackend` (`apps/api/src/execution/self-hosted-backend.ts`) stamps `provenance`.
- **Ownership precedent**: personal ownership (`owner=subject`, no role gate) — originally mirrored the now-removed Connected accounts; the pattern persists for personal runners + personal API keys.

## `everdict runner` (`apps/cli/src/main.ts` `runnerCommand`)
`--pair <rnr_…> --api-url … [--max-concurrent N] [--mount-codex-login] [--ready-timeout-ms/--ready-interval-ms]`. Self-advertises `detectCapabilities()` each lease; `--mount-codex-login` opt-in binds `~/.codex` into containerized (`case.image`) jobs so codex runs in-image with the machine login (own-pays; explicit, since the credential is exposed to the job container).

## Distribution — a headless machine that has no everdict (`docs/architecture/runner-distribution.md`)
The registered-runner dialog prints `everdict runner --pair …`, but a bare host has no `everdict` (the CLI is
an unpublished pnpm-workspace package). The bootstrap is a self-contained `everdict-runner` binary: a
**runner-only entry** (`apps/cli/src/runner-standalone.ts` → `runner-command.ts`, extracted from `main.ts`) is
esbuild-bundled (`apps/cli/esbuild.mjs`, `pnpm --filter @everdict/cli bundle`) into one file that EXCLUDES
`@everdict/orchestrator` — Temporal's native `core-bridge` can't be bundled, and the runner path never needs it.
That bundle → Node SEA → GitHub Release asset (`cli-v*`), fetched by a control-plane-served `install.sh` that
installs + pairs in one paste. Never add an orchestrator/backends import to the runner entry (it breaks the bundle).

See `docs/architecture/self-hosted-runner.md` (shipped personal tier) · `docs/architecture/self-hosted-service-runner.md` (DockerTopologyRuntime) · `docs/architecture/portable-harness-runtime.md` (case.image local↔managed) · `docs/architecture/runner-distribution.md` (standalone binary + install.sh) · `docs/runtimes.md`. Skills: `desktop` (Electron shell), `backends` (push placement + budget), `topology` (service harnesses).
