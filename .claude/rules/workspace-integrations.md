---
paths: "apps/api/src/github-app-service.ts,apps/api/src/mattermost-service.ts,apps/api/src/mattermost-command-service.ts,apps/api/src/ci-link-service.ts,apps/api/src/trace-sink-service.ts,apps/api/src/oauth/github-app.ts"
---
# Workspace-scoped integrations rules (push)

External integrations are **workspace-owned, not personal** (personal Connected accounts were removed in S6c).
GitHub App + Mattermost + CI links + image registries + trace sinks live on `WorkspaceSettings`, gated by
`settings:write` (admin). Registries and sinks are **plural, name-keyed rosters** (upsert by `name`,
`DELETE …/:name`); which trace sink a harness exports to is a **per-harness member+ choice**
(`traceSinkByHarness`, `PUT /harnesses/:id/trace-sink`) — config is admin, selection is member.
GHE **host comparisons are normalized** (`sameHost` — trailing slash/case-insensitive; the web mirrors it) —
never compare registration/installation hosts with `===`. SSOT: `docs/architecture/workspace-scoped-integrations.md` +
`docs/architecture/github-actions-trigger.md` + `docs/architecture/workspace-image-registry.md` +
`docs/architecture/trace-sink.md`.

- **Secrets are NAME references, never values.** `privateKeySecretName` (GHE App private key), `botTokenSecretName`,
  `commandTokenSecretName` are SecretStore *names* — resolved at point of use, never stored on the settings record
  and never returned by a `*View`. A view/GET must be safe to expose (metadata only).
- **GitHub App = installation tokens scoped to the chosen repos.** Org install → selected repos → a
  **workspace-owned** installation token (`GithubAppService`) used for private-repo clone / CI setup-PR / runner
  registration. github.com App comes from operator env (`config.githubCom`); a GHE App is workspace-registered
  (`host + slug + appId + privateKeySecretName`). Base URL differs by `installation.host` (api.github.com vs
  `host/api/v3`) — resolve it, never hardcode. Runner-registration tokens need `administration:write`; a missing
  install on the target owner is a `NotFoundError` (install the App first), never a raw GitHub 403/404.
- **CI link = an OIDC trust policy, keyed by (host, repository).** A `WorkspaceCiLink` (repo ↔ harness slot)
  existing *is* the repo's trust — creation grants keyless auth, so gate it as admin. `host` absent = github.com;
  the same `owner/name` may be linked on github.com AND a GHE, so every lookup (upsert/remove/setup-PR/trust
  match) compares both. Runs authenticate via GitHub Actions OIDC federation → the `ci` role (no stored secret);
  GHES issuers (`https://<host>/_services/token`) are trusted dynamically ONLY for hosts present in the hinted
  workspace's links (`githubActionsAuthenticator` `enterprise.hostsFor`, fail-closed), and the trust match is
  host-strict — a github.com token never satisfies a GHE link of the same name. Installation-token resolution is
  also host-strict (`tokenForRepository(…, host)`). `renderCiWorkflow` emits `id-token: write` + digest-pinned
  image builds against the host's registry (github.com → `ghcr.io`, GHE → `containers.<hostname>` — GHES
  `GITHUB_TOKEN` cannot log in to ghcr.io), and (per `link.trigger` `auto|comment|both`, default both) a
  `/evaluate` PR-comment trigger — `issue_comment` runs in **default-branch context**, so the template must keep:
  the author-association gate (fork-PR defense), explicit `refs/pull/N/head` checkout + `git rev-parse HEAD`
  (`GITHUB_SHA` points at main), PR-number `concurrency`, and conversation feedback via `github-token`
  (comment fires get no PR check). In run-eval, `issue_comment` maps to **pr** mode — never a durable re-pin.
- **CI placement is ALWAYS self-hosted (D6).** `renderCiWorkflow` has no GitHub-hosted path — a private control
  plane must stay reachable from the workflow, so the defaults are `runs-on: [self-hosted]` +
  `runtime: self:ws` (workspace runner pool); `link.runsOn`/`runtime` only *narrow* (a specific label /
  `self:ws:<id>` / a managed runtime id). Personal-runner runtimes (`self`, `self:<id>`) are rejected at upsert
  (a `via:"github-actions"` principal can never lease them), and `openSetupPr` **fails closed** when the
  effective runtime targets the pool and the workspace has zero shared runners (a merged workflow with no
  runner sits silently queued on GitHub — block before the PR, the earliest observable point). Never
  reintroduce `ubuntu-latest` as a default.
- **Mattermost**: bot-token notifications (completion/regression) + inbound slash-commands/buttons; inbound is only
  active when `commandTokenSecretName` is set (verify the command token before acting on `/everdict`).
- Remap every GitHub/Mattermost API failure to an `AppError` (never leak a raw upstream error). One service core,
  two transports (HTTP route + MCP tool) — BFF↔MCP parity, see rule `mcp`.
