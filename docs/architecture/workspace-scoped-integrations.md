---
kind: wiki
title: "Workspace-scoped integrations (GitHub App + Mattermost) — replacing personal Connected accounts"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/github-app/github-app.routes.ts, apps/api/src/api/mattermost/mattermost.routes.ts, packages/application-control/src/github-app/github-app-service.ts, packages/application-control/src/mattermost/mattermost-service.ts, packages/application-control/src/mattermost/mattermost-command-service.ts]
---
# Workspace-scoped integrations (GitHub App + Mattermost) — replacing personal Connected accounts

GitHub (github.com and GitHub Enterprise) and Mattermost are **workspace-owned integrations**. They replaced
the personal Connected accounts feature, which has been removed.

## Why

Personal Connected accounts connected a member's github.com account through a GitHub **OAuth App**. Its
`repo` scope is **all-or-nothing**: the token reaches *every* public and private repository the member can
reach, GitHub offers no per-repository selection at grant time, and the token belongs to one person's login
(it leaves with them, and teammates cannot see it).

The product needs:

1. **Per-repository access** enforced *by GitHub*, not by app-level filtering.
2. **Team-owned** repository access, decoupled from any single member's login.
3. **Self-serve** setup from the web, with no operator involvement per workspace.

Only a GitHub **App** (the installation model) gives (1) and (2): an org owner installs the App and picks
repositories, and GitHub issues short-lived **installation tokens** scoped to exactly those repositories.

## Decisions

- **Installations are workspace-owned** (org install), never personal.
- **GitHub Enterprise works exactly like github.com.** One operator-**env** App per host for the whole
  deployment; a workspace admin only installs and picks repositories. The earlier per-workspace GHE App
  registration (`githubApp.registrations`, its routes, MCP tools and web form) was removed.
- **The Mattermost server URL is operator env (`MATTERMOST_HOST`)**, shared by the deployment. A workspace
  never enters a host, and the web never renders it — it only decides whether the integration is available.
  A workspace admin registers the **bot token**, channel and optional slash-command token, all as SecretStore
  name-refs. **Registration is verified against the live server** (`MattermostClient.verify`: the bot token
  must pass `/api/v4/users/me`, and a given channel must pass `/api/v4/channels/{id}`); a failed check blocks
  the save. `POST /workspace/mattermost/probe` runs the same check without saving.
- **Mattermost is multi-connection.** A workspace registers one connection per team or purpose, keyed by
  `name`. Every consumer reads one normalized list, `mattermostConnections()` in `@everdict/domain` (the plural
  field plus the legacy singular registration lifted in as `name: "default"`):
  - **Outbound fans out** to every connection that has a `defaultChannelId`, each through its own bot token.
    A channel on a connection IS the subscription. One connection's missing secret or outage never silences
    the others.
  - **Inbound accepts any connection's token.** The request carries only a token, so verification
    constant-time-compares it against every connection's `commandTokenSecretName` value, comparing all of
    them regardless of which one matched. Fail-closed.
  - **Agent actions select one.** `post_mattermost_message` / `list_mattermost_channels` /
    `get_mattermost_channel_posts` take an optional `connection` name; omitted means the first registered
    one, and an unknown name is a 404 rather than a post to the wrong channel.
- **Personal Connected accounts are gone**: the services, routes, MCP tools, web pages, the
  `GITHUB_OAUTH_CLIENT_*` env, and the `everdict_connections` table (dropped by
  `packages/db/migrations/0046_drop_connections.sql`). Residue: `env.source.connectionId` still parses, and
  `repoTokenFor` is still an optional port on the run and scorecard services, but the API binds nothing to it.
- **No inbound GitHub webhooks.** For GitHub, Everdict is the *client* that mints outbound installation
  tokens; webhook-fired evaluation stays deferred ([github-actions-trigger.md](github-actions-trigger.md)).
  **Mattermost is the deliberate exception**: two-way chat needs a verified inbound surface.

## App registration: two homes (both env), one UX

| Host | App credentials (App ID + slug + PEM private key), operator env | PEM encoding |
|---|---|---|
| **github.com** | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | base64(PEM) or raw PEM (`\n` restored) |
| **GitHub Enterprise `https://ghe.host`** | `GITHUB_ENTERPRISE_HOST`, `GITHUB_ENTERPRISE_APP_ID`, `GITHUB_ENTERPRISE_APP_SLUG`, `GITHUB_ENTERPRISE_APP_PRIVATE_KEY` | base64(PEM) or raw PEM |

Credential resolution (`GithubAppService.resolveAppCreds` / `resolveInstallTarget`) keys off the install
host: no host means the github.com App, a host matching `GITHUB_ENTERPRISE_HOST` (normalized `sameHost`)
means the enterprise App, and any other host is a `BadRequest`. The status view exposes
`providers: { githubCom: boolean, enterprise?: { host } }` so the web renders one install button per
configured host.

## Data model

Everything is non-secret JSONB in `WorkspaceSettings`
(`packages/contracts/src/records/workspace-settings.ts`):

```ts
githubApp: z.object({
  installations: z.array(z.object({
    host: z.string().url().optional(),   // unset = github.com
    installationId: z.number().int(),
    account: z.string().min(1),          // installed org/user login
    connectedBy: z.string(),             // audit — the admin who linked it
    connectedAt: z.string(),
  })).default([]),
}).optional(),

// Legacy read-compat: lifted in as name="default"; a write persists the plural list and clears this.
mattermost: z.object({
  host: z.string().url().optional(),     // no longer written (env-sourced)
  botTokenSecretName: z.string().min(1),
  defaultChannelId: z.string().min(1).optional(),
  commandTokenSecretName: z.string().min(1).optional(),
  inboundToken: z.string().optional(),   // vestigial — ws-in-URL routing replaced it
}).nullable().optional(),

mattermostConnections: z.array(z.object({
  name: z.string().min(1),               // upsert key, e.g. "team-alerts"
  botTokenSecretName: z.string().min(1),
  defaultChannelId: z.string().min(1).optional(),
  commandTokenSecretName: z.string().min(1).optional(),
})).optional(),
```

No token is stored. Installation tokens are minted on demand from the operator-env App private key and live
about an hour; Mattermost tokens are SecretStore name-refs whose values are never returned by any surface.

## Token minting

`apps/api/src/infrastructure/oauth/github-app.ts` signs the **App JWT** (`{ iss: appId, iat, exp <= 10m }`,
RS256) and exchanges it at `POST {apiBase}/app/installations/{id}/access_tokens`, narrowed by `repositories`
and `permissions`. `GithubAppService` resolves the workspace installation by host and owner, then:

- `tokenForRepo(workspace, gitUrl)` — a `contents: read` token for one repository. The run and scorecard paths
  bind it as `installationTokenFor`, and `packages/application-control/src/execution/execute-case.ts` calls it
  for a private `env.source.git` seed. It resolves by **workspace**, so any member's run can use it. The token
  travels as the transient `CaseJob.repoToken` (never persisted) and reaches git through a URL-scoped
  `http.<url>.extraheader` (`packages/contracts/src/execution/git-auth.ts`).
- `tokenForRepository(workspace, "owner/name", permissions, host?)` — write-capable tokens (setup PRs,
  commits, issues). Host-strict, so the same org name on github.com and a GHE never mints across hosts.
- `runnerRegistrationToken(workspace, target, host?)` — an `administration: write` token for GitHub Actions
  self-hosted runner registration.
- `listRepos(workspace)` — every installation's `GET /installation/repositories`, the repository picker.

## Auth / authz

- **Install, unlink, register/remove Mattermost, probe** = admin (`settings:write`). Installation status
  (`GET /workspace/github-app`: installation ids, the callback URL) and `GET /workspace/mattermost` =
  `settings:read`. No new `Authenticator`: for GitHub, Everdict is the outbound client.
- **Posting a message = member (`mattermost:post`).** Registration is governance; *using* the registered
  integration is a member action, named as its own action rather than overloading admin-only `settings:write`.
- **Using the GitHub App = member, on both halves (`github:read` + `github:write`).** Installing the App and
  picking its repositories is governance; every repository the installation covers is then readable and
  writable by a member. The read half used to be `settings:read` (admin-only) while `github:write` was
  already member-level, so a member — and the agent acting as one — could open a pull request against a
  repository it could not read one file of. `github:read` rides the **read** API-key scope. The repository
  set is still the fence: a token is minted per repository against the owner's installation, so a repository
  nobody selected at install time is unreachable to reads and writes alike.
- **The surface on an installed repository.** Read (`github:read`): `list_github_app_repos`
  (`GET /workspace/github-app/repos`) → `list_github_repo_files` → `get_github_file` · `list_github_issues` →
  `get_github_issue` (with its comment thread) · `get_github_pull_request_changes`. Write (`github:write`):
  `create_github_issue` · `comment_on_github_issue` · `set_github_issue_state` (close/reopen — state only,
  never the author's title or body) · `open_github_pr` · `commit_github_files` · `sandbox_git_push`.
- **`open_github_pr` proposes, `commit_github_files` lands.** They are siblings, not a flag on one tool: a PR
  is a change somebody still has to accept, a direct commit is the change. The difference is answered in the
  agent's consent gate rather than in authorization: `commit_github_files` and `sandbox_git_push` are GUARDED
  actions (`apps/agent/src/action-policy.ts`) that keep asking the member even in `auto` mode, while
  `open_github_pr` is not.
- **Every bounded read reports its bound.** `truncated` on the tree listing and the PR diff,
  `commentsTruncated` on an issue thread — a partial answer taken for a complete one is how an agent concludes
  a file does not exist, or reviews half a diff. The tree read (`GithubRepoTreeReader`) reports `truncated`
  when GitHub cut the tree short **or** when the caller's `limit` dropped matches. `commitFiles` returns the
  branch's resulting `headSha`, read after the writes.

## Install / link flow

- `POST /workspace/github-app/install/start` (`start_workspace_github_app_install`) → `{ installUrl }` for
  github.com or the configured GHE. The admin installs on GitHub and **picks repositories**.
- Public `GET /workspace/github-app/callback?installation_id&setup_action&state` → verify `state` → append the
  installation record → redirect to `/{ws}/settings?tab=integrations`.
- `GET /workspace/github-app` (`list_workspace_github_app`) → installations with each one's selected
  repositories (a per-installation soft failure shows `reposError`), `providers`, and the callback URL to
  register as the App's Setup URL. No secrets.
- `DELETE /workspace/github-app/installations/:id` (`unlink_workspace_github_app_installation`) → forget the
  record; the actual uninstall happens on GitHub.

Routes are thin transports (`apps/api/src/api/github-app/`) over one service core
(`packages/application-control/src/github-app/github-app-service.ts`).

## Mattermost integration (two-way)

**Registration** (`settings:write`, web form). `PUT /workspace/mattermost` upserts a connection by `name`
(omitted = `"default"`), `DELETE /workspace/mattermost/:name` removes one, and `GET /workspace/mattermost`
returns `{ host?, connections[] }` — `host` present only means the operator configured a server. MCP twins:
`get_workspace_mattermost`, `set_workspace_mattermost`, `remove_workspace_mattermost`,
`probe_workspace_mattermost`. The probe returns a classified `{ reachable, reason?, … }` and the web's "Test
connection" gates Save on it. A connection with a `commandTokenSecretName` exposes the URLs to register on the
Mattermost side:

- Slash command `/everdict` → `POST {API_PUBLIC_URL}/integrations/mattermost/command?ws=<workspace>`
- Interactive actions → `{API_PUBLIC_URL}/integrations/mattermost/action?ws=<workspace>`

The workspace slug in the URL routes the request (it is not a secret); the token verification above
authenticates it. This replaced an Everdict-minted `inboundToken`, which is why that schema field is vestigial.

**Outbound (Everdict → Mattermost)**, bot token + REST API (`/api/v4/posts`):

- Completion posts come from one event-log consumer, `mm:completions`
  (`packages/application-control/src/notification/mattermost-consumer.ts`): run completed/failed, scorecard
  completed/failed/cancelled, report completed, and project/initiative status updates, fanned out to every
  connection with a channel. The channel is a mirror, not a ledger: a transport failure skips the post.
- **Rerun button.** A scorecard post carries an interactive **Rerun** action when that connection has an
  inbound token and `API_PUBLIC_URL` is set. The button posts back to `/integrations/mattermost/action` with
  the embedded context (the verification token plus dataset and harness), and the action handler re-fires
  dataset × harness. Without either precondition the post stays a plain message — no dead buttons.
- **Agent-callable post.** `POST /workspace/mattermost/messages` + MCP `post_mattermost_message` (over
  `MattermostService.postMessage`) post an arbitrary message to a connection's channel as its bot. Unlike the
  notification path, failures are **surfaced** (config gaps → `BadRequest`; a transport or non-2xx failure →
  the adapter's remapped `UpstreamError`) so the agent and its approver learn the post's fate. The
  conversational agent bridges the whole control-plane MCP catalog, so this tool is on its default surface
  ([agent-conversations.md](agent-conversations.md)).

**Inbound (Mattermost → Everdict)**, two public endpoints verified by
`MattermostCommandService` (`packages/application-control/src/mattermost/mattermost-command-service.ts`):

- `POST /integrations/mattermost/command` — form-urlencoded slash command: `/everdict run <harness> <dataset>`
  (submits a scorecard with `submittedBy: mattermost:<user>`) · `leaderboard <dataset>` · `status` · `help`.
- `POST /integrations/mattermost/action` — a button click; `rerun` is the one action handled.
- **Verification**: missing `?ws=`, no inbound-configured connection, a missing token or a mismatch all fail
  (400 for the missing query, 403 otherwise).

There is no chat principal and no `Authenticator` branch for these requests: the service verifies the token
itself and acts as the workspace. Mapping the Mattermost user to an Everdict identity is not built.

## Non-goals

- Inbound GitHub App **webhooks** / push-triggered evaluation (deferred in
  [github-actions-trigger.md](github-actions-trigger.md)).
- Migrating old personal tokens into installations — members re-install the App.
- GitLab / Bitbucket.
