---
kind: wiki
title: "GitHub Actions trigger — CI-fired evals + zero-input repo↔service integration"
status: current
updated: 2026-09-15
anchors: [packages/application-control/src/ci-link/ci-link-service.ts, packages/auth/src/github-actions.ts, apps/api/src/api/ci-link/ci-link.routes.ts, examples/github-action/run-eval/run-eval.mjs, packages/application-control/src/harness/harness-pin-service.ts]
---
# GitHub Actions trigger — CI-fired evals + zero-input repo↔service integration

> **What exists.**
> - **Fire path.** `ScorecardRecord.origin` provenance (`origin` jsonb, migration 0033); submit-time ephemeral
>   `harness.pins` (registry-level `resolveWithPins`, an unknown slot is a 400); `POST /harnesses/:id/pins`
>   headless re-pin (digest-enforced, idempotent, auto patch-bump); MCP parity (`pin_harness_images`,
>   `run_scorecard` pins/origin); the in-repo reference Action `examples/github-action/run-eval` (node20, published
>   as `everdict/run-eval@v1`).
> - **Keyless auth.** `githubActionsAuthenticator` (issuer pre-check, fail-closed, `AuthContext.workspaceHint`) +
>   the `ci` role + exclusion from membership bootstrap.
> - **Zero-input setup.** `CiLinkService` (link CRUD = the trust policy, repo picker proxy, setup-PR generator
>   `renderCiWorkflow`) + routes/MCP; web: the harness-detail CI integration panel with a connect-repo dialog
>   (repo picker → slots → dataset → save → setup PR), the Settings CI tab, and origin chips on scorecards.
> - **Server-side supersede.** A new submit with the same `(origin.repo, prNumber, harness, dataset)` key
>   reclaims in-flight (queued/running) batches: they become `superseded` (neither succeeded nor failed — invisible
>   to baseline/diff/leaderboard) with `error.code=SUPERSEDED`. The shared `stopInFlight` (also used by user
>   cancel — see `docs/scorecards.md`) aborts the batch cooperatively (remaining cases are never dispatched),
>   cancels a Temporal-owned workflow, drops queued entries, revokes self-hosted leases (`cancelLeased`), and
>   force-kills each child's recorded managed work (`killWork`). GitHub's workflow `concurrency` cancels only the
>   *workflow*; this reclaims the batch it already submitted. Merge/push fires (no `prNumber`) are never
>   superseded. Limit: the cooperative-abort handle map is in-memory, so it assumes one control-plane process.
> - **GitHub Enterprise (GHES).** Host-aware end to end: the picker (`GET /workspace/github-app/repos`) carries
>   each repository's installation `host`; a link is keyed by **(host, repository)**; installation-token
>   resolution is host-strict (`tokenForRepository(…, host)`); the generated workflow pushes to the instance's
>   registry (`containers.<hostname>` — GHES `GITHUB_TOKEN` cannot log in to ghcr.io); fire-time auth accepts
>   the GHES issuer `https://<host>/_services/token` only for hosts in the hinted workspace's links
>   (`githubActionsAuthenticator({ enterprise.hostsFor })`, fail-closed), and trust compares
>   `(claims.host, claims.repository)` so a github.com token never satisfies a GHE link of the same name.
> - **PR-comment fire `/evaluate`.** The workflow also fires on `issue_comment` (created): a PR comment starting
>   with `/evaluate` re-runs the PR-mode ephemeral-pin eval through the same submit path and federation.
>   `WorkspaceCiLink.trigger` (`auto | comment | both`, default `both`) picks the PR firing surface; the push
>   re-pin trigger always stays. The template absorbs the three `issue_comment` traps — the event runs in
>   **default-branch context**, so (a) the job gates on "PR comment + `/evaluate` prefix +
>   `author_association ∈ OWNER/MEMBER/COLLABORATOR`" (fork-PR defense: the event carries secrets and
>   `id-token`); (b) it checks out `refs/pull/N/head` and a `Resolve eval head` step derives the sha with
>   `git rev-parse HEAD` (`GITHUB_SHA` would point at main); (c) GitHub attaches no PR check to comment fires, so
>   the action replies in the conversation (👀 reaction, then a result comment via its `github-token` input;
>   `issues`/`pull-requests: write` are emitted only when the comment trigger is on). `concurrency` is grouped by
>   PR number, and the action maps `issue_comment` to **pr** mode (otherwise a comment would durably re-pin).
>
> **Not built:** a live GHES run (github.com passed — see the end of this page); a GitHub App trigger
> (webhook-fired `/evaluate` with no workflow file — it would have no image build, so it would reuse the PR's
> last-built digests or re-dispatch the workflow); a Check Runs sink; GitLab/Bitbucket.
>
> Direction locked with the user (2026-07-03):
> **(1) Action-as-client, not webhook-receiver** — a first-party GitHub Action calls the Everdict API outbound;
> a GitHub App (inbound webhooks) is deferred until "no workflow-file change" demand is real.
> **(2) Two firing semantics** — PR = *ephemeral* pin override at scorecard submit (registry untouched);
> merge to dev/main = *durable* registry re-pin → new harness-instance version (the "dev channel").
> **(3) Zero-input integration** — a workspace-owned **RepoLink** connects `repository ↔ harness service slot(s)`
> through the repo picker (today the workspace GitHub App installation); the link doubles as the OIDC **trust
> policy**, and Everdict generates the workflow file as a setup PR, so the user types nothing.
>
> Like [scheduled-evals](./scheduled-evals.md): **strict generalization, additive.** The unit of work —
> `ScorecardService.submit(RunScorecardInput)` — is reused verbatim; GitHub Actions is a second trigger
> *source* next to cron. The absence of a RepoLink changes nothing.

## Problem

Teams building **service-topology harnesses** manage each service in its own repo (or several in a monorepo).
They want: *"on every PR — and on every merge to dev/main — CI builds the service image, then Everdict evaluates
the topology with that image, and blocks the PR on regression."* Before this, every scorecard was a manual
`POST /scorecards`; there was no CI trigger, no way to swap one service's image for a PR build, and no
repo↔service wiring. Competing products call this an "integration" and make it one-click — ours had to be too:
**no manual client IDs, no hand-written workflow YAML, no per-call parameters.**

## Building blocks it reuses

- **Topology slot = `TopologyService.name`** (`packages/contracts/src/harness/harness-spec.ts`):
  `ServiceHarnessSpec.services[]` each carry `name` + `image`.
- **The template/instance split already models pinning** (`packages/contracts/src/harness/harness-template.ts`,
  `packages/registry/src/harness/harness-instance-registry.ts`): `HarnessInstanceSpec = { template: {id,version},
  id, version, pins: Record<slot, image>, overrides? }`, and `resolveHarnessInstance(template, instance)` fills
  service images from pins. A CI re-pin is the **headless version of the web "edit → new version" flow**, not a
  new concept.
- **Auth is composable** (`packages/auth`): `compositeAuthenticator([...])` chains GitHub Actions, OIDC, API-key
  (`ak_`) and runner (`rnr_`) authenticators.
- **Regression analytics**: `diffScorecards` + `GET /scorecards/diff`.
- **Self-hosted placement**: `runtime: "self:…"` routes through `apps/api/src/core/execution/runtime-dispatcher.ts`
  → `SelfHostedBackend` → the runner lease loop.
- **Workspace GitHub App** installation tokens, host-aware, with both hosts configured by operator env — see
  [workspace-scoped-integrations.md](./workspace-scoped-integrations.md).

## Design

### D1 — Action-as-client (outbound), GitHub App deferred

The first-party Action (`everdict/run-eval@v1`) calls the Everdict API from the GitHub runner. Outbound calls need
no inbound webhook surface, no HMAC verification, no App installation, and work behind NAT. GitHub-side writes
(PR comment, failing the check) use the workflow's ambient `${{ github.token }}` — **Everdict never holds a GitHub
credential for CI feedback.** The generated workflow file (D3) makes this invisible to the user.

### D2 — PR vs merge: ephemeral override vs durable re-pin

| event | semantics | registry | reproducibility anchor |
|---|---|---|---|
| `pull_request` | evaluate topology with *this* PR's image in one slot | **untouched** | `origin.pinOverrides` on the scorecard (+ `origin.campaignId` when the run is a campaign round — a finding key for the driver's `scorecard.completed` subscription, see `code-evolution-loop.md`) |
| `issue_comment` `/evaluate` | re-run the PR eval **on demand** (same ephemeral pins; PR head resolved explicitly) | **untouched** | `origin.pinOverrides` + `origin.prNumber`/`sha` |
| `push` to dev/main | advance the "dev channel" | **new instance version** (re-pin) | immutable instance version vN+1 |

- **PR (ephemeral):** `RunScorecardInput.harness.pins?: Record<slot, imageRef>` is applied through
  `resolveWithPins` at submit and never persisted to the registry; `origin.pinOverrides` records what ran.
  Registering a version per PR would pollute the instance lineage.
- **Merge (durable):** `POST /harnesses/:id/pins` `{ pins, base?, version? }` — load the base raw
  `HarnessInstanceSpec`, merge pins, bump the version, register. Idempotent (same pins ⇒ the base version is
  returned, nothing registered). A monorepo CI run passes **several slots in one call** → exactly one vN+1.
- **Digest pins, tag kept.** CI must pin a digest (`…@sha256:…`), never a moving tag — otherwise scorecard
  reproducibility and per-version leaderboard comparison break silently. The re-pin route rejects non-digest refs
  (`BadRequestError`) unless the request passes `allowTags: true`. The generated workflow emits the combined form
  `ghcr.io/<repo>/<slot>:<sha>@sha256:…`: the digest decides what runs, and the commit-sha tag keeps the pinned
  version readable (a digest-only pin is reproducible and unidentifiable).

Baseline for a PR diff: the Action's `baseline` input, or else the latest **succeeded** scorecard of the same
dataset × harness.

### D3 — RepoLink: the zero-input integration

One workspace-owned record wires everything (`WorkspaceCiLinkSchema` in
`packages/contracts/src/records/workspace-settings.ts`):

```ts
// WorkspaceSettings.ci
ci?: {
  links: Array<{
    repository: string;                       // "acme/app"
    host?: string;                            // GHE base URL; absent = github.com. Key = (host, repository)
    harness: string;                          // instance id, e.g. "my-topology"
    slots: Record<string, { path?: string }>; // serviceName → optional monorepo path filter
    createdBy: string;                        // audit only — fire-time auth does NOT depend on the creator
    disabled?: boolean;
    trigger?: "auto" | "comment" | "both";    // PR firing surface (default both); push re-pin always fires
    runsOn?: string;                          // narrowing override — default "[self-hosted]" (D6)
    runtime?: string;                         // narrowing override — default "self:ws" pool (D6; personal self:… rejected)
  }>;
}
```

**Connect UX (no typing):** harness detail → CI integration → "Connect repository" → repo picker (thin proxy
`GET /workspace/github-app/repos` over the workspace GitHub App installation — only the repositories GitHub scoped
to the install) → select repo and service slots (optional monorepo path) → save. Then one button: **"Open setup
PR"** — Everdict uses a workspace installation token to push a branch adding `.github/workflows/everdict-eval.yml`
and open a PR. The generated file embeds everything (workspace slug, `permissions: id-token: write`, build steps
with digest outputs per linked service, path filters for monorepos, a `concurrency` group per PR number). Merge
it — done. The Action takes **no user-typed inputs**; the only runtime data it forwards is the digest map its own
build step emitted.

The RepoLink **is** the trust policy: its existence authorizes that repository's OIDC tokens into the workspace
(D4). No separate policy screen. Because fire-time auth is repository federation (not a personal token), links
have **no creator-left problem** — unlike schedules, no auto-disable hook is needed.

**Gating.** Creating or deleting a link is a trust grant, so it is `settings:write` (admin). Listing links and
opening the setup PR are `harnesses:read` — the PR still needs a merge on GitHub, and the trust was already
granted by the link.

### D4 — Auth: GitHub Actions OIDC federation (keyless)

`packages/auth/src/github-actions.ts` joins the composite chain: issuer
`https://token.actions.githubusercontent.com` (or a linked GHES issuer), verified with the same jose remote-JWKS
pattern as `oidc.ts`, `aud: "everdict"`. Claims carry `repository`, `ref`, `sha`, `workflow`, `run_id`,
`event_name`.

Fire-time resolution: the generated workflow pins the **workspace slug**, so the server verifies
`claims.repository` against **that workspace's** `ci.links` — no cross-tenant global repository index, and the
same repository may legitimately be linked in two workspaces. On a match the principal is
`{ via: "github-actions", workspace, subject: "gha:<repository>", roles: ["ci"] }`. The `ci` role grants exactly
`scorecards:run`, `scorecards:read`, `harnesses:read` and `harnesses:register` (the re-pin) — not settings. A
workspace API key in a repository secret (the Action's `api-key` input) remains the fallback; OIDC is preferred.

### D5 — Provenance + feedback

- `ScorecardRecord.origin` (`ScorecardOriginSchema` in `packages/contracts/src/records/scorecard.ts`):
  `source` plus `repo`, `sha`, `ref`, `prNumber`, `runUrl`, `pinOverrides` for CI fires; schedules and other
  submitters stamp their own `source`. The web list shows a commit chip, which answers "which eval covered this
  commit".
- The Action polls to terminal, calls `GET /scorecards/diff` against the baseline, writes a step summary, and
  exits non-zero on regression (the PR check fails; `fail-on-regression` defaults on in PR mode). PR comments use
  the ambient `github.token`. Server-side GitHub sinks (Check Runs) would only matter with a GitHub App.

### D6 — Placement: CI always runs on self-hosted runners (decided 2026-07-07)

The generated workflow **never targets GitHub-hosted runners**. An Everdict control plane is frequently deployed
on a private network; a GitHub-hosted runner cannot reach `api-url`, so a `runs-on: ubuntu-latest` workflow fails
late (merged, then a CI network timeout — the most confusing failure mode). Rather than modelling reachability
(operator env + heuristics + a conditional generator), the branch was removed: **every generated workflow is
self-hosted**, which is fail-closed by construction and matches the one-command dual-worker install
(`POST /workspace/runners/github-install` / MCP `github_install_workspace_runner` = a GitHub Actions runner plus an
Everdict `self:ws` runner on one build server).

- **Defaults (zero-input):** `runs-on: [self-hosted]` + `runtime: self:ws` (the workspace runner pool).
  `link.runsOn` / `link.runtime` are **narrowing overrides** (a specific label / `self:ws:<id>` / a managed
  runtime id), not the hosted-vs-self decision.
- **Fail-closed at setup-PR time:** when the effective runtime targets the workspace pool, `openSetupPr` requires
  the pool to be non-empty (a specific id must exist) and otherwise throws `BadRequestError` pointing at the runner
  install flow. A workflow merged with zero runners would sit silently queued on GitHub.
- **Personal runners are rejected:** `link.runtime` of `self`/`self:<id>` is a `BadRequestError` at upsert — a
  `via: "github-actions"` principal can never lease a member's personal runner (owner = submitter). A
  **workspace-shared** runner (`self:ws:<id>`) is targetable by any principal scoped to that workspace, because
  the dispatcher derives the owner from the job's tenant. See
  `docs/architecture/self-hosted-runtime-and-runners.md` §3–4.
- **Side benefits:** build and eval share the build server's docker daemon (the just-pushed image is already
  local), persistent layer cache, no GitHub-hosted minute billing. Private registry pulls elsewhere use workspace
  image-registry credentials ([workspace-image-registry.md](./workspace-image-registry.md)).
- **Costs, accepted:** the zero-infra path for *publicly reachable* control planes is gone (a team must register
  one runner before CI evals). A hosted-runner story would return as an explicit `runsOn: ubuntu-latest` opt-in
  (the fields exist, no migration). **Public-repo caveat:** fork PRs on self-hosted runners execute untrusted
  code — GitHub advises against self-hosted runners for public repos; Everdict's target is private team repos.

## /evaluate arguments

`key=value` tokens after the command tune that ONE fire without editing the workflow:
`/evaluate limit=20 tags=smoke,fast trials=3 runtime=self:ws sink=none`. Supported: `limit`/`tags`/`ids`
(case subset), `trials` (pass@k), `concurrency`, `retries` (0–5), `runtime` (override, incl. comma shard list /
`auto` / `self:…`), `sink` (per-batch trace-sink override, `none` suppresses export). Parsed inside the action
(`examples/github-action/run-eval/parse-evaluate-args.mjs` — the comment body comes from the event payload, so no
workflow change); malformed or unknown tokens are WARNINGS surfaced in the PR reply, never failures — a typo must
not cost the fire.

## Live verification (github.com)

Full loop PASS against a real repository (2026-07-09, `Ho2eny/assay-selfhosted-e2e` + a real self-hosted Actions
runner + the published `everdict/run-eval@v1`): workflow generated by `renderCiWorkflow` from a real CI link → PR
auto fire → an `/evaluate limit=1 concurrency=1` comment cancelled the in-flight auto fire (GitHub concurrency
group) and re-fired with the arguments applied (typo token surfaced as a warning in the reply) → keyless OIDC
federation authenticated the submits → result + baseline diff ("No regressions") replied in the PR conversation.
Two defects found live and fixed in the action: an empty `images: '{}'` map made push fires attempt an empty
re-pin (400), and the ~5-minute GitHub OIDC token expired mid-poll on long evals (the action now refreshes it once
on a 401). GHES remains unverified against a real GHE server.
