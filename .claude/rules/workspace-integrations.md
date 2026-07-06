---
paths: "apps/api/src/github-app-service.ts,apps/api/src/mattermost-service.ts,apps/api/src/mattermost-command-service.ts,apps/api/src/ci-link-service.ts,apps/api/src/trace-sink-service.ts,apps/api/src/oauth/github-app.ts"
---
# Workspace-scoped integrations rules (push)

External integrations are **workspace-owned, not personal** (personal Connected accounts were removed in S6c).
GitHub App + Mattermost + CI links + the image registry + the trace sink live on `WorkspaceSettings`, gated by
`settings:write` (admin). SSOT: `docs/architecture/workspace-scoped-integrations.md` +
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
  `GITHUB_TOKEN` cannot log in to ghcr.io).
- **Mattermost**: bot-token notifications (completion/regression) + inbound slash-commands/buttons; inbound is only
  active when `commandTokenSecretName` is set (verify the command token before acting on `/assay`).
- Remap every GitHub/Mattermost API failure to an `AppError` (never leak a raw upstream error). One service core,
  two transports (HTTP route + MCP tool) — BFF↔MCP parity, see rule `mcp`.
