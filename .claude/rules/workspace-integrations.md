---
paths: "apps/api/src/github-app-service.ts,apps/api/src/mattermost-service.ts,apps/api/src/mattermost-command-service.ts,apps/api/src/ci-link-service.ts,apps/api/src/oauth/github-app.ts"
---
# Workspace-scoped integrations rules (push)

External integrations are **workspace-owned, not personal** (personal Connected accounts were removed in S6c).
GitHub App + Mattermost + CI links + the image registry live on `WorkspaceSettings`, gated by `settings:write`
(admin). SSOT: `docs/architecture/workspace-scoped-integrations.md` +
`docs/architecture/github-actions-trigger.md` + `docs/architecture/workspace-image-registry.md`.

- **Secrets are NAME references, never values.** `privateKeySecretName` (GHE App private key), `botTokenSecretName`,
  `commandTokenSecretName` are SecretStore *names* — resolved at point of use, never stored on the settings record
  and never returned by a `*View`. A view/GET must be safe to expose (metadata only).
- **GitHub App = installation tokens scoped to the chosen repos.** Org install → selected repos → a
  **workspace-owned** installation token (`GithubAppService`) used for private-repo clone / CI setup-PR / runner
  registration. github.com App comes from operator env (`config.githubCom`); a GHE App is workspace-registered
  (`host + slug + appId + privateKeySecretName`). Base URL differs by `installation.host` (api.github.com vs
  `host/api/v3`) — resolve it, never hardcode. Runner-registration tokens need `administration:write`; a missing
  install on the target owner is a `NotFoundError` (install the App first), never a raw GitHub 403/404.
- **CI link = an OIDC trust policy.** A `WorkspaceCiLink` (repo ↔ harness slot) existing *is* the repo's trust —
  creation grants keyless auth, so gate it as admin. Runs authenticate via GitHub Actions OIDC federation → the
  `ci` role (no stored secret). `renderCiWorkflow` emits `id-token: write` + digest-pinned image builds.
- **Mattermost**: bot-token notifications (completion/regression) + inbound slash-commands/buttons; inbound is only
  active when `commandTokenSecretName` is set (verify the command token before acting on `/assay`).
- Remap every GitHub/Mattermost API failure to an `AppError` (never leak a raw upstream error). One service core,
  two transports (HTTP route + MCP tool) — BFF↔MCP parity, see rule `mcp`.
