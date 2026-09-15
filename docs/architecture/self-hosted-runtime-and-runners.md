---
kind: wiki
title: "Self-hosted runtime & runners — a pool you target, workers that drain it"
status: current
updated: 2026-09-15
anchors: [apps/api/src/core/execution/runtime-dispatcher.ts, packages/application-control/src/runner/runner-hub.ts, packages/application-control/src/runner/github-runner-install.ts, apps/api/src/api/runner/workspace-runner.routes.ts]
---
# Self-hosted runtime & runners — a pool you target, workers that drain it

[self-hosted-runner.md](./self-hosted-runner.md) describes the pull/lease/MCP machinery with one personal runner as
the target. This page is what is built on top of it: pools a job can target, runners owned by a workspace rather
than a member, and a GitHub Actions runner co-registered on the same host. The push backends (`nomad|k8s`) are
unaffected.

## Terminology

| Layer | What it is | Scales by |
| --- | --- | --- |
| **Runtime** | **Where** execution happens — the placement a job's `runtime` (→ `placement.target`) selects. | fixed per environment |
| **Runner** | **Who** executes — a worker process that leases jobs, runs them and reports back. | more runners = more concurrent jobs |

A machine is not a first-class entity: one machine can host several runners, and a pool can span several machines.
A GitHub Actions runner and an Everdict runner are both just workers that can live on the same host.

The code still calls the **pairing** a "runner" (`POST /runners`, `RunnerStore`), and a pool is not a separate
registered entity: a pool is the set of runners with one owner.

## Placement targets

`RuntimeDispatcher` (`apps/api/src/core/execution/runtime-dispatcher.ts`) recognizes four self-hosted targets. None
falls through to a cluster — a self-hosted pin is intentional.

| target | routes to | owner | who may target it |
| --- | --- | --- | --- |
| `self:<runnerId>` | one personal runner | the submitter | the owner only (D3) |
| `self` | the personal pool — any of my runners | the submitter | the owner only |
| `self:ws:<runnerId>` | one workspace-owned runner | `ws:<tenant>` | any member of the workspace |
| `self:ws` | the workspace pool — any workspace-owned runner | `ws:<tenant>` | any member of the workspace |

For the workspace targets the owner is derived from the **job's tenant**, never from an argument, so workspace
membership is the access check and targeting another workspace's runner is structurally impossible (404).

Pool dispatch refuses early where it can: no runner in the pool → 404; no runner advertising the job's required
functional capabilities → 400 naming what is missing; capable runners that are all offline → the job parks and
`onWaiting` says so.

## How a pool drains

`RunnerHub` (`packages/application-control/src/runner/runner-hub.ts`) keys pool jobs by `poolKeyFor(owner)` with the
`POOL_RUNNER` (`"*"`) sentinel. A runner's `lease` serves its own queue first, then its owner's pool queue:

- on its OWN queue a capability mismatch rejects the job (`capability_mismatch`) — the runner was named explicitly;
- on the POOL queue a mismatch is skipped and left for a capable runner (`requiredRunnerCapabilities`, which includes
  `docker` for a containerized service harness);
- `enqueue` wakes the owner's polling runners round-robin, so no runner hogs the pool;
- the result carries `ranBy`, so `provenance.runner` names the runner that actually ran a pool job.

Concurrency is `Σ runners × their --max-concurrent workers`. Adding runners is the primary scaling story because it
spans machines.

## Workspace-owned runners

A workspace runner is a runner whose owner is `ws:<workspace>` in the same `RunnerStore` — no separate store or
schema. Managed by admins (`settings:write`):

| HTTP (`apps/api/src/api/runner/workspace-runner.routes.ts`) | MCP |
| --- | --- |
| `POST /workspace/runners` — pair; returns the token once, `attachCommand` and `installCommand` | `pair_workspace_runner` |
| `GET /workspace/runners/owned` — team-owned runners | `list_workspace_owned_runners` |
| `DELETE /workspace/runners/:id` | `revoke_workspace_runner` |

`GET /workspace/runners` (`members:read`) is the roster, which also lists personal runners paired in the workspace.
The web surface is the **Shared runners** settings tab (register, list with online and capability badges, revoke).

**Who pays.** `billingTenant(result, tenant)` (`packages/domain/src/billing/cost.ts`): a self-hosted result whose
`provenance.by` starts with `ws:` settles to that workspace; a personal self-hosted result settles to no tenant (the
owner's login pays); a managed result settles to the job's tenant. `SelfHostedBackend` stamps `provenance.by` with
the runner's owner, so no extra signal is needed.

## GitHub Actions runner co-registration

A machine in a workspace pool is where a GitHub Actions self-hosted runner belongs: CI builds the image and calls
Everdict, and the Everdict runner beside it executes the eval.

- `installGithubWorkspaceRunner` (`packages/application-control/src/runner/github-runner-install.ts`) pairs a fresh
  workspace runner, mints a GitHub registration token, and renders a one-shot install script that runs **both**
  `config.sh` and `everdict runner --pair`, plus a workflow hint: `runs-on: [self-hosted, everdict-<id>]` and the
  run-eval `runtime: self:ws:<id>`.
- The token is minted through the **workspace GitHub App** installation with `administration: write`
  (`GithubAppService.runnerRegistrationToken`, via `CiLinkService.mintRunnerToken`) against a repository or an org —
  no personal OAuth scope. It is short-lived and never stored. A target where the App is not installed is a
  `NotFoundError`; `host` (a GHE base URL) restricts minting to that host's installation, and without it the
  github.com installation is preferred.
- Surfaces: `POST /workspace/runners/github-install { repository | org, host?, runnerGroup?, label?, githubLabels?,
  capabilities? }` and MCP `github_install_workspace_runner` (`settings:write`); `runnerGroup` (org targets only)
  adds `--runnergroup`. The web dialog picks the repository or org from the App's installations.
- `WorkspaceCiLink` carries optional `runsOn` / `runtime`, so `renderCiWorkflow` targets the self-hosted pool directly;
  they are settable through `PUT /workspace/ci/links` and MCP `link_ci_repository`.

A `via: "github-actions"` principal targeting `self:ws:<id>` works because the dispatcher derives the owner from the
job's tenant.

## Live proofs

`scripts/live/multi-runner-pool.mjs` (two runners drain `self:ws`) · `scripts/live/personal-pool.mjs` (`self`) ·
`scripts/live/workspace-shared-runner.mjs` (`self:ws:<id>`, `provenance.by = ws:default`, cross-workspace 404) ·
`scripts/live/github-self-hosted-runner.mjs` with the runbook
[github-self-hosted-runner.md](../runbooks/github-self-hosted-runner.md) (a real repo-level GitHub runner drove a run
on `self:ws` to `succeeded`; org-level was not live-verified).

## Decisions / non-goals

- **`--max-concurrent` stays** as the per-process convenience; adding runners is the primary scaling knob.
- **The personal owner-only rule is unchanged** — an admin cannot target a member's personal runner or pool;
  cross-member sharing exists only through workspace-owned runners.
- **The in-process `local` runtime remains dev-only.**
- **Not built:** a distinct registered "self-hosted runtime" entity, per-pool join tokens and an
  `everdict runner --join` flag. A runner joins a pool by being paired to its owner.

## See also

[self-hosted-runner.md](./self-hosted-runner.md) · [runtimes.md](../runtimes.md) ·
[github-actions-trigger.md](./github-actions-trigger.md) · [workspace-scoped-integrations.md](./workspace-scoped-integrations.md) ·
[tenancy.md](../tenancy.md) · skills `backends`, `api-layer`, `self-hosted-runner`.
