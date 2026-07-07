# GitHub Actions trigger — CI-fired evals + zero-input repo↔service integration

> **Status: slices 1–3 SHIPPED (2026-07-03).**
> S1 `5534b15` — `ScorecardRecord.origin` provenance (+`origin` jsonb mig 0033) + submit-time ephemeral
> `harness.pins` (registry-level `resolveWithPins`, unknown slot = 400) + `POST /harnesses/:id/pins` headless
> re-pin (digest-enforced, idempotent, auto patch-bump) + MCP parity (`pin_harness_images`, `run_scorecard`
> pins/origin) + the in-repo reference Action `examples/github-action/run-eval` (zero-dep node20).
> S2 `3be9c3e` — `githubActionsAuthenticator` (issuer pre-check, fail-closed, `AuthContext.workspaceHint`) +
> `ci` role (scorecards:run/read + harnesses:register/read only) + membership-bootstrap exclusion.
> S3 `2cc8b7f` (backend) + web slice — `CiLinkService` (links CRUD = trust, repos picker proxy, setup-PR
> generator `renderCiWorkflow`) + routes/MCP ×5 + web: harness-detail "CI 연동" panel + connect-repo dialog
> (connection→repo picker→slots→dataset→save→setup-PR), settings "CI 연동" tab, scorecard origin chips.
> **Server-side supersede — SHIPPED.** A new submit with the same `(origin.repo, prNumber, harness, dataset)`
> key reclaims in-flight (queued/running) batches: marks them `superseded` (new scorecard status; neither
> succeeded nor failed — invisible to baseline/diff/leaderboard) with `error.code=SUPERSEDED`, and aborts them
> cooperatively (`runSuite` `signal` — remaining cases are never dispatched; already-dispatched cases drain
> naturally into child runs, partial results preserved, completion notification skipped). GH-side workflow
> `concurrency` cancels only the *workflow*; this reclaims the already-submitted batch (orphan-eval fix).
> Merge/dev fires (no `prNumber`) are never superseded. Limits: cooperative only (no backend job kill);
> single-control-plane-process assumption (in-memory AbortController map, same as the callback rendezvous).
>
> **GitHub Enterprise (GHES) support — SHIPPED (2026-07-06).** The repo connect flow is host-aware
> end-to-end: the picker (`GET /workspace/github-app/repos`) carries each repo's installation `host`
> (GHE badge in the web picker), the RepoLink stores `host` and is keyed by **(host, repository)**
> (the same `owner/name` may be linked on github.com *and* a GHE), installation-token resolution is
> host-strict (`tokenForRepository(…, host)` — no cross-host mismint when the same org name exists on
> both), the generated workflow pushes to the instance's container registry
> (`containers.<hostname>`, not ghcr.io — GHES `GITHUB_TOKEN` cannot log in to ghcr.io), and
> fire-time auth accepts the GHES Actions issuer `https://<host>/_services/token` dynamically:
> `githubActionsAuthenticator({ enterprise.hostsFor })` trusts only hosts that appear in the hinted
> workspace's GHE links (fail-closed), and trust matching compares `(claims.host, claims.repository)`
> against the link — a github.com token never satisfies a GHE link of the same name (or vice versa).
> Routes/MCP grew the optional `host` (`PUT/DELETE /workspace/ci/links`, setup-pr,
> `link_ci_repository`/`unlink_ci_repository`/`open_ci_setup_pr`).
>
> **PR-comment fire `/evaluate` (ChatOps) — SHIPPED (2026-07-07).** The generated workflow also fires on
> `issue_comment` (created): a PR-conversation comment starting with `/evaluate` re-runs the PR-mode
> ephemeral-pin eval on demand — same `ScorecardService.submit` path, same OIDC federation (trust matches
> `(host, repository)` only, so **zero auth change**). `WorkspaceCiLink.trigger` (`auto | comment | both`,
> default `both`) picks the PR firing surface (`comment` = on-demand only, for expensive suites); the push
> re-pin trigger always stays. The template absorbs the three `issue_comment` traps — the event runs in
> **default-branch context**, so: (a) the job gates on "is PR comment + `/evaluate` prefix +
> `author_association ∈ OWNER/MEMBER/COLLABORATOR`" (fork-PR defense — the event carries secrets +
> `id-token`); (b) it checks out `refs/pull/N/head` explicitly and a `Resolve eval head` step derives the
> evaluated sha via `git rev-parse HEAD` (image tags + the action's new `head-sha` input use it —
> `GITHUB_SHA` would silently point at main); (c) GitHub attaches **no PR check** to comment fires, so the
> action replies to the conversation (👀 reaction on receipt, result/failure comment via the new
> `github-token` input; `issues`/`pull-requests: write` are emitted only when the comment trigger is on).
> `concurrency` is now grouped by PR number (`pull_request.number || issue.number || ref`) so a comment fire
> supersedes the same PR's in-flight auto fire GH-side; server-side supersede works unchanged because the
> action reads `origin.prNumber` from the event payload for comment fires — and `issue_comment` maps to
> **pr** mode (without that mapping a comment would durable-re-pin the registry). Routes/MCP/web carry the
> `trigger` knob (`PUT /workspace/ci/links`, `link_ci_repository`, connect-repo dialog + link rows).
>
> **Open:** live E2E vs real GitHub (github.com + GHES, incl. an `/evaluate` comment fire); GitHub App (S4,
> demand-driven — would give webhook-fired `/evaluate` with instant reactions and no workflow file, but no
> image build: it would reuse the PR's last-built digests or re-dispatch the workflow); personal-runner
> `allowCi` gate; Track B pull-secrets for private GHCR; backend job force-kill for superseded in-flight
> cases; `/evaluate` argument parsing (`dataset=… runtime=…` → action inputs).
>
> Direction locked with the user (2026-07-03):
> **(1) Action-as-client, not webhook-receiver** — a first-party GitHub Action calls the Assay API outbound;
> a GitHub App (inbound webhooks) is deferred until "no workflow-file change" demand is real.
> **(2) Two firing semantics** — PR = *ephemeral* pin override at scorecard submit (registry untouched);
> merge to dev/main = *durable* registry re-pin → new harness-instance version (the "dev channel").
> **(3) Zero-input integration** — a workspace-owned **RepoLink** connects `repository ↔ harness service slot(s)`
> via the existing repo picker UX (member's GitHub connection); the link doubles as the OIDC **trust policy**, and
> Assay generates the workflow file as a setup PR, so the user types nothing.
>
> Like [scheduled-evals](./scheduled-evals.md): **strict generalization, additive.** The unit of work —
> `ScorecardService.submit(RunScorecardInput)` — is reused verbatim; GitHub Actions is just a second trigger
> *source* next to cron. The absence of a RepoLink changes nothing.

## Problem

Teams building **service-topology harnesses** manage each service in its own repo (or several in a monorepo).
They want: *"on every PR — and on every merge to dev/main — CI builds the service image, then Assay evaluates
the topology with that image, and blocks the PR on regression."* Today every scorecard is a manual
`POST /scorecards`; there is no CI trigger, no way to swap one service's image for a PR build, and no
repo↔service wiring. Competing products call this an "integration" and make it one-click — ours must be too:
**no manual client IDs, no hand-written workflow YAML, no per-call parameters.**

## Current state — verified

- **Topology slot = `TopologyService.name`** (`packages/core/src/harness-spec.ts`): `ServiceHarnessSpec.services[]`
  each carry `name` + `image` (+ env/volumes/readiness/resources).
- **Template/instance split already models pinning** (`packages/core/src/harness-template.ts`,
  `packages/registry/src/harness-{template,instance}-registry.ts`): `HarnessInstanceSpec = { template: {id,version},
  id, version, pins: Record<slot, image>, overrides? }`; `resolveHarnessInstance(template, instance)` fills service
  images from pins and throws `BadRequestError` on missing/mismatched pins. `POST /harnesses` registers instance
  versions; `GET /harnesses/:id/:version/instance` returns the raw instance (pins) — the web "수정→새 버전" flow
  already re-pins through this. A CI re-pin is the **headless version of an existing flow**, not a new concept.
- **Submit-time seam exists** (`apps/api/src/scorecard-service.ts` ~154–168): `submit()` resolves the harness via
  `deps.harnesses.get(tenant, id, version)` before dispatch — the single point to apply an ephemeral pin override.
- **Auth is composable** (`packages/auth`): `compositeAuthenticator([...])` already chains OIDC (jose
  `createRemoteJWKSet`), API-key (`ak_`), and runner (`rnr_`) authenticators; adding a 4th issuer is additive.
- **Regression analytics exist**: `diffScorecards` + `GET /scorecards/diff`; schedules already do
  fire → finalize → diff-vs-previous → `notifyRegression` (Mattermost).
- **Self-hosted placement exists**: `runtime: "self:<id>"` routes through `runtime-dispatcher.ts` →
  `SelfHostedBackend` → runner-hub `lease_job` long-poll. CI-fired runs can land on a member's machine.
- **Workspace GitHub App** holds workspace-owned installation tokens (org install → selected repos), host-aware
  (github.com via operator env / GHE workspace-registered). A repo-listing proxy route exists
  (`GET /workspace/github-app/repos`) and GitHub App infrastructure (installations, per-repo installation tokens)
  is in place — see [workspace-scoped-integrations.md](./workspace-scoped-integrations.md). (Migrated in S6b/S6c
  from the earlier personal Connected accounts, since removed.)
- **`ScorecardRecord` has no origin/provenance fields** (`packages/db/src/scorecard-store.ts`) — submitter,
  trigger source, and commit identity are not recorded today.

## Design

### D1 — Action-as-client (outbound), GitHub App deferred

A published first-party Action (`assay-ai/run-eval@v1`) calls the Assay API from the GH runner. Outbound calls
need no inbound webhook surface, no HMAC verification, no App installation, and work behind NAT. GitHub-side
writes (PR comment, failing the check) use the workflow's ambient `${{ github.token }}` — **Assay never holds a
GitHub credential for CI feedback.** The generated workflow file (D3) makes this invisible to the user.

### D2 — PR vs merge: ephemeral override vs durable re-pin

Two lifecycles, two registry treatments:

| event | semantics | registry | reproducibility anchor |
|---|---|---|---|
| `pull_request` | evaluate topology with *this* PR's image in one slot | **untouched** | `origin.pinOverrides` on the scorecard |
| `issue_comment` `/evaluate` | re-run the PR eval **on demand** (same ephemeral pins; PR head resolved explicitly) | **untouched** | `origin.pinOverrides` + `origin.prNumber`/`sha` |
| `push` to dev/main | advance the "dev channel" | **new instance version** (re-pin) | immutable instance version vN+1 |

- **PR (ephemeral):** `RunScorecardInput.harness` grows `pins?: Record<slot, imageRef>` — merged over the
  resolved instance's pins at the `scorecard-service.ts` seam, never persisted to the registry. What ran is
  recorded in the new `origin` field (below). PR-per-version registration would pollute the instance lineage;
  Track A derivation lineage remains available later if PR artifacts ever need durable registration.
- **Merge (durable):** new route `POST /harnesses/:id/pins` `{ pins: { "<slot>": "<imageRef>" }, base?: version }`
  — sugar over the existing raw-instance read + `POST /harnesses`: load latest raw `HarnessInstanceSpec`, merge
  pins, bump version, register. Idempotent (same pins ⇒ same version returned, no new registration). A monorepo
  CI run passes **multiple slots in one call** → exactly one vN+1 (no intermediate version spam).
- **Digest-only pins.** CI must pin `ghcr.io/…@sha256:…`, never a moving tag — otherwise scorecard
  reproducibility and the per-version leaderboard comparison break silently. The re-pin route rejects tag-only
  refs (`BadRequestError`) unless the instance opts out.

Baseline for a PR diff = latest **succeeded** scorecard of the same instance lineage (the dev channel). Reuses
`diffScorecards`; needs only a "latest succeeded scorecard for harness id" lookup.

### D3 — RepoLink: the zero-input integration

One workspace-owned record wires everything:

```ts
// WorkspaceSettings.ci — sibling of `integrations` (JSONB, admin/member-writable, see gating below)
ci?: {
  links: Array<{
    repository: string;                       // "acme/app" (host-aware via integrations for GHE)
    host?: string;                            // absent = github.com
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

**Connect UX (no typing):** harness detail → topology diagram → click a service node → "Connect repository" →
repo picker (thin proxy `GET /workspace/github-app/repos` over the workspace GitHub App installation → the repos
GitHub scoped to the install) → select repo (monorepo: multi-select services, optional path) → link saved. Then one button:
**"Open setup PR"** — Assay uses the workspace installation token (scoped to the linked repos) to push a branch
adding `.github/workflows/assay-eval.yml` and open a PR. The generated file embeds everything (workspace slug,
`permissions: id-token: write`, build steps with GHCR digest outputs per linked service, path filters for
monorepos, `concurrency: assay-eval-${{ github.ref }}` for GH-side superseding). Merge it — done. The Action
itself takes **no user-provided inputs**; the only runtime data it forwards is the image digest map emitted by
its own build step.

The RepoLink **is** the trust policy: its existence authorizes that repository's OIDC tokens into the workspace
(D4). No separate policy screen. Because fire-time auth is repo-based federation (not a personal token), links
have **no creator-left problem** — unlike schedules, no auto-disable hook is needed; the personal connection is
used only at setup time (picker + setup PR).

### D4 — Auth: GitHub Actions OIDC federation (keyless)

4th authenticator in the composite chain (`packages/auth/src/github-actions.ts`):
issuer `https://token.actions.githubusercontent.com`, verified with the same jose `createRemoteJWKSet` pattern as
`oidc.ts`, `aud: "assay"`. Claims carry `repository`, `ref`, `sha`, `workflow`, `run_id`, `event_name`.

Fire-time resolution: the generated workflow pins the **workspace slug** (zero user input — we wrote the file),
so the server verifies `claims.repository` against **that workspace's** `ci.links` — no cross-tenant global
repo index, and the same repo may be legitimately linked in two workspaces. On match:
`Principal { via: "github-actions", workspace, subject: "gha:<repository>", roles: ["ci"] }`. The `ci` role grants
exactly `scorecards:run|read` + the re-pin action — not general `harnesses:write`, not settings. Bootstrap
fallback (works today, kept forever): a workspace API key in a repo secret; the Action supports both, OIDC
preferred.

### D5 — Provenance + feedback

- `ScorecardRecord.origin?: { source: "github-actions" | "schedule" | "api" | "web", repo?, sha?, ref?,
  prNumber?, runUrl?, pinOverrides? }` — set by all submitters (schedules stamp `source: "schedule"`). Web list
  shows a commit chip; enables "which eval covered this commit".
- The Action polls to terminal, calls `GET /scorecards/diff` vs the dev-channel baseline, writes a step summary,
  and exits non-zero on regression (= PR check fails). PR comments via ambient `github.token`. Server-side
  GitHub sinks (Check Runs) only become relevant with a future GitHub App.
- Server-side supersede (in-flight scorecard with same `origin.repo+prNumber` gets cancelled by a newer fire) is
  a later slice; the generated workflow's `concurrency` group covers the common case for free.

### D6 — Placement: CI always runs on self-hosted runners (decided 2026-07-07)

The generated workflow **never targets GitHub-hosted runners**. An Assay control plane is frequently deployed on
a private network; a GitHub-hosted runner cannot reach `api-url`, so a `runs-on: ubuntu-latest` workflow fails
late (merged, then a CI network timeout — the most confusing failure mode). Rather than modeling reachability
(operator env + heuristics + a conditional generator), we removed the branch: **every generated workflow is
self-hosted**, which is fail-closed by construction and matches the shipped one-command dual-worker install
(`POST /workspace/runners/github-install` = GitHub Actions runner + Assay `self:ws` runner on one build server).

- **Defaults (zero-input):** `runs-on: [self-hosted]` (any self-hosted runner registered on the repo/org) +
  `runtime: self:ws` (the workspace runner pool — any capable shared runner drains it). `link.runsOn` /
  `link.runtime` are **narrowing overrides** (a specific label / `self:ws:<id>` / a managed runtime id), not the
  hosted-vs-self decision.
- **Fail-closed at setup-PR time:** when the link's effective runtime targets the workspace pool
  (`self:ws`/`self:ws:<id>`), `openSetupPr` requires the pool to be non-empty (specific id must exist) and
  otherwise throws `BadRequestError` pointing at the runner install flow. A workflow merged with zero runners
  would sit silently queued on the GitHub side — blocking the PR is the earliest observable failure point.
- **Personal runners are rejected:** `link.runtime` of `self`/`self:<id>` is a `BadRequestError` at upsert — a
  `via:"github-actions"` principal can never lease a member's personal runner (owner = submitter), so such a
  link can only fail at fire time.
- **Side benefits:** build and eval share the build server's docker daemon (the just-pushed image is already
  local — private-GHCR pull mostly moot), persistent layer cache, no GitHub-hosted minute billing.
- **Costs, accepted:** the zero-infra path for *publicly reachable* control planes is gone (a team must register
  one runner before CI evals; acceptable — evals need compute anyway). If a hosted-runner story is ever wanted
  again it returns as an explicit `runsOn: ubuntu-latest`-style opt-in (fields already exist, no migration).
  **Public-repo caveat:** fork PRs on self-hosted runners execute untrusted code — GitHub advises against
  self-hosted runners for public repos; Assay's target is private team repos, documented here.

## Slices

1. **Fire path (no new auth):** `origin` field + `RunScorecardInput.harness.pins` (ephemeral merge at the
   scorecard-service seam) + `POST /harnesses/:id/pins` (durable re-pin, digest-enforced, idempotent) + the
   published Action (API-key auth, poll, diff, step summary, exit code). MCP parity: `pin_harness_images`,
   `run_scorecard` gains `pins`. Independently useful without any GitHub wiring.
2. **OIDC federation:** `githubActionsAuthenticator` + `ci` role + workspace verification against `ci.links`
   (link records may initially be written via a plain settings route). Removes long-lived repo secrets.
3. **Zero-input UX:** `GET /workspace/github-app/repos` proxy + harness-detail "Connect repository" picker +
   `ci.links` CRUD (BFF + MCP parity) + **setup-PR generator** (workflow YAML synthesized from the link:
   build steps, digest outputs, path filters, concurrency, workspace slug).
4. **Later / demand-driven:** server-side supersede; GitHub App (webhook-fired, zero workflow file); Check Runs
   sink; GitLab/Bitbucket — RepoLink and the federation shape are deliberately provider-neutral.

## Dependencies & open decisions

- **Private image pull (Track B).** PR/dev images in private GHCR need pull credentials in the topology
  runtimes (k8s `imagePullSecrets` / docker login from the workspace SecretStore). This use case is the
  strongest argument for prioritizing Track B; interim: cluster-preconfigured pull secret.
- **CI on a self-hosted runner. ✅ RESOLVED via the workspace-shared runner tier.** `resolveSelfRunner(owner,
  runnerId)` still enforces personal ownership for `self:<id>` (a `via:"github-actions"` principal can't lease a
  *member's personal* runner). But a **workspace-shared** runner (`self:ws:<id>`) is targetable by any principal
  scoped to that workspace — including `via:"github-actions"` — because the dispatcher derives the owner from the
  job's tenant (`ws:<tenant>`), so workspace membership *is* access. `POST /workspace/runners/github-install` /
  MCP `github_install_workspace_runner` stand up a GitHub Actions runner + an Assay `self:ws:<id>` runner on one
  build server in a single command. See `docs/architecture/self-hosted-runtime-and-runners.md` §3–4. (A per-runner
  `allowCi` opt-in for *personal* runners is no longer needed for the CI use case.) As of D6 this is not just
  *supported* but the **only** placement the generator emits.
- **Link write gating.** Creating a link both wires a harness and grants repo-federated access — lean
  `settings:write` (admin) for creation, since it is a trust grant; the picker/setup-PR UX stays member-visible
  read-only until an admin confirms. To revisit when the UX is built.
