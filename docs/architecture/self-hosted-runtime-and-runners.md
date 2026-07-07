# Self-hosted runtime & runners — a pool you target, workers that drain it

> **Status: DESIGN (not yet built).** A strict, additive generalization of the shipped
> [self-hosted-runner](./self-hosted-runner.md): same pull/lease/MCP machinery, re-drawn around the correct
> two-layer model so "runtime vs runner" stops being confusing. Nothing about the push backends
> (`nomad|k8s`) changes.

## Terminology (the whole point — lock this first)

Two concepts, one axis each. **There is no "device" layer** — the machine *is* a self-hosted runtime.

| Layer | What it is | Scales by | Examples |
|---|---|---|---|
| **Runtime** | **Where** execution happens — the environment / placement a job targets. | (fixed per environment) | `self-hosted` (localhost / your own infra), `docker`, `nomad`, `k8s`, `topology` |
| **Runner** | **Who** executes — a **worker process**, the execution subject. Joins a runtime, leases one job at a time, runs it, reports back. | **more runners = more concurrent jobs** | an `assay runner` worker · a GitHub Actions runner |

- A **runtime** is the *pool / placement*. A job's `runtime` field (→ `placement.target`) picks it.
- A **runner** is a *worker* that joins a runtime and drains its queue. **One machine can host many runners; many machines can join one runtime.** Want to pull 2 jobs at once on a beefy host → run 2 runners.
- **A machine is not a first-class thing.** "My laptop with plenty of resources" = a `self-hosted` runtime that I've joined N runners to. Both a **GitHub Actions runner** and an **Assay runner** are just workers that happen to live on that same self-hosted host, side by side.

> **Naming migration.** The shipped code calls the *pairing* a "runner" (`POST /runners`, `self:<runnerId>`) **and**
> the *worker process* a "runner" (`assay runner`). That collision is the confusion. Corrected: the pairing/pool
> becomes a **self-hosted runtime**; the worker stays the **runner**. `self:<runnerId>` (target one specific worker)
> generalizes to **`runtime = <self-hosted-runtime>`** (target the pool; any of its runners leases).

## Problem — three gaps in the shipped model

The shipped self-hosted runner nailed pull/lease/provenance/budget, but under the "runner ≈ personal device" framing it has three limits:

1. **Placement targets one specific worker, not a pool.** `self:<runnerId>` pins a job to a single paired
   runner. Concurrency comes only from `--max-concurrent` (N workers *inside one process*). You cannot spread a
   queue across **multiple runner processes or multiple machines** by joining them to one target. (The user's
   "2 jobs waiting, beefy host, pull 2" wants *runners* as the unit, not one process's worker count.)
2. **Self-hosted runtimes are personal-only.** `RunnerStore` is keyed by `owner=subject`; there is no
   **workspace-owned** self-hosted runtime. Team CI needs an always-on, shared, workspace-owned pool of build
   servers that survives any individual member leaving — not one dev's laptop.
3. **No self-serve GitHub Actions runner.** Registering a GitHub Actions self-hosted runner (to build images and
   trigger evals from CI) is fully manual today (download `actions/runner`, fetch a registration token by hand,
   `config.sh`, `run.sh`, set repo secrets). A workspace should be able to stand one up in a couple of clicks.

## Current state — verified (`docs/architecture/self-hosted-runner.md`)

- **Placement** — `runtime` selector → `placement.target`; `RuntimeDispatcher` (`apps/api/src/runtime-dispatcher.ts`)
  branches on `target.startsWith("self:")` → owner-checked lease queue; else resolves a workspace `RuntimeSpec` →
  `buildRuntimeBackend` → push via `Scheduler`.
- **Pull/lease** — `SelfHostedBackend` + `RunnerHub` (`apps/api/src/runner-hub.ts`): lease queue keyed
  `(owner, runnerId)` = `self:<owner>:<runnerId>` (cross-workspace). `RunnerHub.lease` is single-thread-atomic
  (concurrent `lease_job` never double-hands a job → the basis for many workers/runners sharing a queue).
- **Worker** — `assay runner --pair <rnr_…>` (`apps/cli` → `@assay/runner-core` `runLeaseWorkers`): one process,
  `--max-concurrent N` lease workers over one MCP session. `runnerAuthenticator` maps `rnr_` → `Principal{via:"runner"}`.
- **Ownership precedent** — personal (`owner=subject`, account page, no role gate) mirrors Connected accounts
  (since removed in S6c — see [workspace-scoped-integrations.md](./workspace-scoped-integrations.md)).
  Workspace-shared runtimes (`nomad|k8s`) are the `RuntimeRegistry` (immutable, `_shared` fallback).

## Design

### 1. Self-hosted runtime = the pool you target (personal **or** workspace)

Promote the pairing to a **self-hosted runtime**: a named queue that jobs target and runners join. Two ownership
tiers on the *runtime* (not the worker):

| | **Personal self-hosted runtime** | **Workspace self-hosted runtime** |
|---|---|---|
| owner | `principal.subject` (today's model) | the **workspace** (new) |
| lives on | a member's own machine | company build server(s) / VM(s) |
| pays | member's own login (own-pays, budget untouched) | workspace secrets / a team CI login (workspace-scoped) |
| managed by | the member (account page, no role gate) | admin (`settings:write`) — a team asset |
| isolation | user's own host (hardened-isolation bypassed, tagged) | tenant-isolated (`TrustZonePolicy`) — a shared host must not leak across tenants |
| target | `runtime = self:<personal-runtime-id>` | `runtime = <workspace-runtime-id>` |
| survives member leaving | no (personal) | **yes** (workspace-owned) |

The **queue is keyed by the runtime** (pool), not by a single runner. `RunnerHub`'s key generalizes
`(owner, runnerId)` → `(runtimeRef)` where `runtimeRef` is `self:<owner>:<id>` (personal) or `ws:<workspace>:<id>`
(workspace). Any runner joined to that runtime leases from the one queue — `lease` atomicity already guarantees
no double-hand.

### 2. Runner = a worker that **joins** a runtime

`assay runner` gains `--join <runtime-ref>` (a join token scopes it to one runtime). Run it **N times** (N
processes, or on N machines) to put N runners on a pool → N concurrent jobs. `--max-concurrent` stays as a
per-runner convenience (workers within one process); effective concurrency = `Σ runners × their workers`.
Presence/heartbeat is per-runner, so the roster shows *the pool and each runner in it*.

- **Personal** join: pair on the account page (or desktop one-click) → `rnr_` token bound to the personal runtime.
- **Workspace** join: an admin creates a workspace self-hosted runtime, gets a **join token** (or an install
  script); each build server runs `assay runner --join ws:<ws>:<id> --token …`. Multiple servers = multiple
  runners on the pool.

### 3. Placement & dispatch (reuse the seam)

`RuntimeDispatcher` branch widens from `self:<runnerId>` to any self-hosted runtime ref:
- `self:<subject>:<id>` → personal pool, **owner-checked** (only the owner may target it — unchanged rule).
- `ws:<workspace>:<id>` → workspace pool, **workspace-scoped** (any member may target it, per role); tenant
  isolation enforced because the pool is shared. No fallthrough to a cluster (a self-hosted pin is intentional).

Everything downstream (`Scheduler` fairness/budget/capacity, `RunStore`/`ScorecardStore`, provenance tag) is unchanged.

### 4. GitHub Actions runner = a co-resident worker on a self-hosted host (repo-level first)

A machine in a **workspace self-hosted runtime** is exactly where a GitHub Actions self-hosted runner belongs
(it builds the image and calls Assay; the Assay runner next to it executes the eval). Self-serve flow, reusing
the workspace GitHub App + CI links:

1. Admin picks a **GitHub repo** (workspace GitHub App repo picker, `GET /workspace/github-app/repos`) for the workspace runtime.
2. Assay mints a **registration token** via the workspace GitHub App installation: `POST /repos/{owner}/{repo}/actions/runners/registration-token`
   (`ci-link-service` calls the GitHub API with the workspace installation token — same seam). *Org-level
   (`/orgs/{org}/…`, needs `admin:org` opt-in) is supported; **repo-level** works with the App's default repo install.*
3. Assay emits a **one-liner / install script** the build server runs: it (a) configures `actions/runner`
   (`config.sh --url … --token <reg> --labels …`) **and** (b) `assay runner --join ws:<ws>:<id>` — one command
   stands up *both* workers on that host.
4. The generated workflow (`renderCiWorkflow`) targets `runs-on: [self-hosted, <label>]` and passes
   `runtime: ws:<ws>:<id>` to the eval action, so the CI build and the eval both land on that pool.

Registration tokens are **short-lived** and fetched on demand; Assay never stores a long-lived runner token. The
runner, once configured, holds its own GitHub credential — a company resource, not tied to the admin's identity.

### Reuse vs new

| Piece | Status |
|---|---|
| `runAgentJob`/`AgentJob`/`CaseResult`, `Scheduler`, `RunStore`/`ScorecardStore`, MCP lease protocol, provenance/budget | **reused verbatim** |
| `RunnerHub` lease queue | **generalized** key `(owner,runnerId)` → `(runtimeRef)` (pool) |
| `RuntimeDispatcher` `self:` branch | **widened** to `self:<subj>:<id>` + `ws:<ws>:<id>` |
| Personal self-hosted runtime (today's `RunnerStore` pairing) | **reused** (renamed concept: pairing = a personal runtime) |
| **Workspace self-hosted runtime** (owner=workspace, admin-managed, tenant-isolated) | **new** |
| `assay runner --join <runtime>` (worker joins a pool; N per pool) | **new** (extends `--pair`) |
| GitHub Actions registration-token mint + install-script generator | **new** (`ci-link-service` seam) |
| Workspace "Runners" settings UI (pools + runners + join/install + GitHub register) | **new** (web) |

## Slices (each `pnpm`-green; BFF↔MCP parity where human-facing)

1. **Terminology + pool key.** Land this doc; generalize `RunnerHub` to key by `runtimeRef` (personal pool with
   1 runner = today's behavior, back-compat); rename in code/docs so *runtime* = pool, *runner* = worker. No user-visible change.
2. **Multi-runner workspace pool (`self:ws`) — ✅ SHIPPED.** Target `self:ws` (no runner id) routes to the
   **workspace pool**: any of that workspace's shared runners (capability-satisfying) drains it — N runners = N
   concurrency. `RunnerHub` gains a `POOL_RUNNER` (`"*"`) sentinel + `poolKeyFor(owner)`: `lease(runnerKey)` serves
   the runner's own queue first, then the owner's pool queue — and on the pool, a capability mismatch is **skipped**
   (left for a capable runner), not rejected. Pool jobs live in the pool queue; a runner completes with its own key
   and `locate()` finds it there; `enqueue` wakes the owner's polling runners **round-robin** (`wakeCursor`) so no
   runner hogs. `enqueue` resolves `{result, ranBy}` so `provenance.runner` is the **actual** runner that ran a pool
   job (not `"*"`). `requiredRunnerCapabilities` adds `docker` for service harnesses so the pool routes them to a
   docker runner. `RuntimeDispatcher` handles `target==="self:ws"` (before the `self:<id>` branch) via a
   `poolHasRunners(owner)` check (404 if none). Web: the run form's runtime picker shows "팀 공유 러너 (아무거나)"
   when the workspace has shared runners. Live e2e `scripts/live/multi-runner-pool.mjs` (2 runners → `self:ws` → all
   routed to workspace runners; deterministic distribution proven by unit tests). **Personal pool (`self`) —
   SHIPPED too:** the pool branch is generalized to `self:ws | self` (owner = `ws:<tenant>` | the submitter), so a
   user can run N runner processes/machines under one personal pool and target `self` (own-pays). Web run form
   offers "내 러너 (아무거나)"; live e2e `scripts/live/personal-pool.mjs` (PASS).
3. **Workspace self-hosted runtime.** ✅ **SHIPPED.** Realized as a workspace-owned **runner** (owner=`ws:<workspace>`
   in the existing owner-keyed runner-store — no new store/schema; the shared "pool" *is* the workspace-owned runner
   set). Admin CRUD gated `settings:write`: `POST /workspace/runners` (pair, plaintext token once) ·
   `GET /workspace/runners/owned` (team-owned only; the roster `GET /workspace/runners` still lists personal runners
   paired in the ws) · `DELETE /workspace/runners/:id`. `RuntimeDispatcher` `self:ws:<id>` branch derives owner from
   the **job's tenant** (`ws:<tenant>`), so membership *is* access and cross-workspace is structurally impossible
   (always looks up `ws:<tenant>`); personal `self:<id>` stays owner-only (D3). Full BFF↔MCP parity
   (`pair_workspace_runner`/`list_workspace_owned_runners`/`revoke_workspace_runner`) + web settings **공유 러너** tab
   (register → token-once + `assay runner --pair` command; list with online/capability badges; revoke).
   **Workspace-pays — SHIPPED.** `billingTenant(result, tenant)` (`@assay/backends` budget): a run whose
   `provenance.by` starts `ws:` settles to that workspace (team pays); personal self-hosted stays own-pays
   (`undefined`); managed = the job tenant. `RunService`/`ScorecardService` settle through it. `provenance.by` =
   the runner owner stamped by `SelfHostedBackend`, and a workspace runner's owner is `ws:<workspace>` — no new
   signal. **Live e2e:** `scripts/live/workspace-shared-runner.mjs` (pair → `assay runner` → `self:ws:<id>` run →
   `provenance.by="ws:default"` + cross-workspace `NOT_FOUND`); verified PASS.
4. **GitHub Actions runner co-registration (repo-level). ✅ SHIPPED (backend + MCP).** `CiLinkService.mintRunnerToken`
   (workspace GitHub App, `administration:write` → `POST /repos/{repo}/actions/runners/registration-token`, short-lived,
   never stored) + `installGithubWorkspaceRunner` (`github-runner-install.ts`): pairs a workspace runner (fresh
   `rnr_`) + mints the GitHub token + renders a one-shot install script (`config.sh` **and** `assay runner --pair`)
   + a workflow hint (`runs-on: [self-hosted, assay-<id>]` + run-eval `runtime: self:ws:<id>`). Route
   `POST /workspace/runners/github-install` + MCP `github_install_workspace_runner` (`settings:write`). This is the
   resolution of the github-actions-trigger open item "CI can't lease a personal runner — needs `allowCi` **or a
   workspace-shared runner tier**": a `via:"github-actions"` principal targeting `self:ws:<id>` works because the
   dispatcher derives the owner from the job tenant (workspace membership = access). The run-eval action already
   accepts a `runtime` input. **Web + RepoLink — SHIPPED.** Settings › 공유 러너 tab has a **GitHub Actions 러너**
   dialog driven by the **workspace GitHub App** (no raw owner/name input): the target is picked from the
   installations' allowed repos (search + GHE host badge) or the installed orgs; when the App isn't installed the
   dialog requires it (CTA that switches to the 통합 tab — install first, then pick). The picker threads the
   installation's `host` so the registration token is minted against the exact installation (host-strict).
   `WorkspaceCiLink` grew optional `runsOn`/`runtime` (additive JSONB) so `renderCiWorkflow`
   targets self-hosted directly (`runs-on: <label>` + run-eval `runtime: self:ws:<id>`); settable via the CI-links
   connect dialog ("5. 셀프호스티드 러너"), HTTP `PUT /workspace/ci/links`, and MCP `link_ci_repository`.
5. **Org-level runner registration — ✅ SHIPPED.** Org-level uses
   `POST /orgs/{org}/actions/runners/registration-token`, which needs `administration:write` on the target. Rather
   than a personal OAuth `admin:org` scope, this comes from the **workspace GitHub App** installation:
   `GithubAppService.runnerRegistrationToken(workspace, {repo}|{org})` resolves the installation for the target
   owner and mints an App token with `administration: write` — a missing install on that owner is a `NotFoundError`
   (install the workspace App on the org first). `mintRunnerToken` takes a `{repo}|{org}` target;
   `installGithubWorkspaceRunner` accepts `org` (mutually exclusive with `repository`) and points `config.sh --url`
   at the org URL. Surfaced on `POST /workspace/runners/github-install {org?}`, MCP
   `github_install_workspace_runner {org?}`, and the web dialog (repo/org toggle). All three surfaces also take an
   optional `host` (GHE base URL): given → only that host's installation is used (host-strict, else `NotFound`);
   omitted → the github.com installation is preferred, then any host (legacy — GHE-only workspaces keep working
   without a host). **Org runner groups — SHIPPED:** an optional `runnerGroup`
   (org-level only) adds `config.sh --runnergroup <name>` so the org's group access policy applies to the runner
   (route/MCP/web params). **Runner labels for placement — SHIPPED** as capability-gated pool routing (slice 2): the
   pool's lease gate skips runners lacking a job's required capabilities, so `self:ws` routes each job to a suitable
   runner. **Real-GitHub self-hosted registration — ✅ LIVE-VERIFIED (repo-level, 2026-07-05):** a genuine GitHub
   Actions self-hosted runner (registered via the exact `mintRunnerToken` API call, `--ephemeral`) picked up a
   `workflow_dispatch` job that drove an Assay run on `self:ws` → `succeeded`, `provenance.ranOn=self-hosted`,
   `by=ws:default` (workspace-pays), workflow conclusion **success**. Runbook + evidence:
   `docs/runbooks/github-self-hosted-runner.md`; turnkey helper `scripts/live/github-self-hosted-runner.mjs`.
   Org-level (`admin:org`) still runbook-only (test token lacked the scope). Personal multi-runner is SHIPPED as
   the `self` personal pool (slice 2).

## Decisions / non-goals

- **`--max-concurrent` stays**, but "add runners" is the primary scaling story (matches GitHub; spans machines).
- **Personal owner-only rule is unchanged** — an admin still cannot target a *member's personal* runtime. The new
  cross-member sharing lives only on **workspace** runtimes (which are workspace assets, tenant-isolated).
- **Push backends untouched** (`nomad|k8s`); the in-process `local` runtime remains dev-only.
- **Org-level GitHub registration is opt-in** (SHIPPED, slice 5): the elevated `admin:org` scope is requested
  only when the admin explicitly connects/reconnects elevated — the default connection scope stays
  `repo, read:packages` (no over-request). Repo-level remains the zero-extra-scope default.

## See also

[self-hosted-runner.md](./self-hosted-runner.md) · [runtimes.md](../runtimes.md) ·
[github-actions-trigger.md](./github-actions-trigger.md) · [workspace-scoped-integrations.md](./workspace-scoped-integrations.md) · [tenancy.md](../tenancy.md) ·
skills `backends`, `api-layer`.
