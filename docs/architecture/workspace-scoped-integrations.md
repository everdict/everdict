# Workspace-scoped integrations (GitHub App + Mattermost) — replacing personal Connected accounts

> **Status:** design (S0). SSOT for the migration from **personal Connected accounts** to
> **workspace-owned integrations**. Supersedes the outbound-OAuth connection model in
> `docs/connections.md` for GitHub/GHE/Mattermost (that doc is retired in S6).

## Why

Personal Connected accounts connect a member's github.com account via a GitHub **OAuth App**. The
`repo` scope is **all-or-nothing** — it grants the token access to *every* public+private repo the
member can reach. There is no per-repository selection at the GitHub grant level, and the token is
tied to one person's login (leaves with them, bills to them, invisible to teammates).

The product needs:

1. **Per-repository access** enforced *by GitHub*, not by app-level filtering.
2. **Team-owned** repo access — decoupled from any single member's personal login.
3. **Self-serve** setup from the web (no operator involvement per workspace).

Only a GitHub **App** (installation model) gives (1) and (2): an org owner installs the app and picks
repos; GitHub issues short-lived **installation tokens** scoped to exactly those repos. So we move
*all* GitHub/GHE repo access to workspace-owned GitHub App installations, and re-scope Mattermost
notifications to a workspace-level self-serve credential — then delete the personal connection
feature entirely.

## Decisions (locked)

- **Scope:** GitHub App installations are **workspace-owned** (org install), not personal.
- **GHE parity:** GitHub Enterprise works identically — same install→select-repos→workspace-owned
  model, **host-aware**. Difference is *where the App is registered* (see below), not the UX.
- **Mattermost (full two-way):** workspace-registered corporate Mattermost (host + **bot token** +
  slash-command token, all SecretStore name-refs) → **outbound** notifications *and* **inbound**
  slash commands + interactive buttons. An admin registers it once per workspace (self-serve web
  form); every member's runs/notifications in that workspace use it. This adds Assay's **first
  inbound integration surface** (verified, workspace-scoped) — a deliberate, contained exception to
  the "no inbound webhooks" stance (which still holds for GitHub App push triggers).
- **Remove personal Connected accounts entirely** (github, github-enterprise, mattermost personal
  connections + the applications roster + the OAuth `integrations`). Done **last**, after the
  replacements are live, so no window breaks repo-clone or notifications.
- **No inbound *GitHub* webhooks.** For GitHub we remain the *client* (mint outbound installation
  tokens); GitHub App push-triggered eval stays deferred (`github-actions-trigger.md`). **Mattermost
  is the deliberate exception** — full two-way needs a verified inbound surface (see the Mattermost
  section below).

## App registration: two homes, one UX

A GitHub App is registered **per GitHub host**. We mirror today's github.com-in-env / GHE-in-workspace
split, but with **App** credentials (App ID + PEM private key) instead of OAuth client id/secret:

| Host | App registration (App ID + private key) | Analogous to today |
|---|---|---|
| **github.com** | operator **env** — one App for the deployment: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM), `GITHUB_APP_SLUG` | `GITHUB_OAUTH_CLIENT_ID/SECRET` env |
| **GHE `https://ghe.host`** | **workspace-registered** by an admin: `{ host, appId, privateKeySecretName }` — private key stored in the workspace SecretStore (name-ref, value never returned) | `WorkspaceSettings.integrations[ghe]` OAuth app |

The **installation** (the thing that grants repo access) is workspace-owned in both cases. From the
member's perspective the flow is identical: *install on org → pick repos → workspace can clone them.*

## Target data model

Everything non-secret lives in `WorkspaceSettings` JSONB (like `integrations` and `ci.links` today);
the only secret (GHE App private key, Mattermost webhook URL) is a **SecretStore name-ref**.

```ts
// packages/db/src/workspace-settings.ts — WorkspaceSettingsSchema additions
githubApp: z.object({
  // GHE App registrations (github.com uses operator env → not listed here). Admin-registered.
  registrations: z.array(z.object({
    host: z.string().url(),                 // GHE base URL (github.com omitted — env)
    appId: z.string().min(1),
    privateKeySecretName: z.string().min(1),// SecretStore key holding the PEM (value never returned)
  })).default([]),
  // Workspace-owned installations (github.com + GHE). One per installed org.
  installations: z.array(z.object({
    host: z.string().url().optional(),      // omitted = github.com
    installationId: z.number().int(),       // GitHub installation id
    account: z.string().min(1),             // org/user login the app is installed on
    connectedBy: z.string(),                // audit — principal.subject of the admin who linked
    connectedAt: z.string(),
  })).default([]),
}).optional(),

// mattermost: personal connection → workspace-registered corporate Mattermost (full two-way).
// Replaces the old notify { connectionId, channelId, ownerSubject } entirely (migrated in S5/M1).
mattermost: z.object({
  host: z.string().url(),                        // corporate Mattermost base URL
  botTokenSecretName: z.string().min(1),         // SecretStore key — bot access token (outbound posts, threads, DMs, interactive)
  commandTokenSecretName: z.string().optional(), // SecretStore key — slash-command/action token (inbound verification)
  defaultChannelId: z.string().optional(),       // default notify channel
  inboundToken: z.string().optional(),           // Assay-minted opaque token embedded in the registered command/action URL → routes inbound to this workspace
}).optional(),
```

Installation records hold **no long-lived token** — installation tokens are minted on demand from the
App private key (env for github.com, SecretStore for GHE) and are short-lived (~1h). So no new
encrypted store is needed; JSONB + SecretStore name-refs suffice. `assay_connections` is **dropped**
in S6.

## Token minting (the core)

`apps/api/src/oauth/github-app.ts` (new), host-aware like `github.ts`:

1. **App JWT** — sign `{ iss: appId, iat, exp<=10m }` with RS256 using the App private key.
2. **Installation token** — `POST {apiBase}/app/installations/{id}/access_tokens` with
   `{ repositories: [name], permissions: { contents: "read" } }` → GitHub returns a token **restricted
   to those repos + permissions**, expiring in ~1h.
3. `installationTokenForRepo(workspace, { host?, owner, repo })` resolves the workspace installation
   for that host+owner, loads the App private key (env for github.com, SecretStore name-ref for GHE),
   mints a token scoped to `owner/repo`, returns it.

This is the **workspace analog of `repoTokenFor`** — resolved by **workspace** (not submitter
subject), so any member's run in the workspace uses it. The transient plumbing is unchanged: the
token is carried as `AgentJob.repoToken` (never persisted), injected into git via `http.extraheader`
(`packages/environments/src/repo.ts`, already implemented).

## Repo-source wiring (S3)

Today `env.source = { git, ref, connectionId? }` where `connectionId` → personal connection resolved
against the submitter. New: reference the **workspace installation** instead. The resolver keys off
**workspace**, so it works for any member and needs no personal login.

```ts
// env.source gains a workspace-installation reference (discriminated from personal connectionId,
// which is removed in S6). Resolution: parse owner/name from `git` → installationTokenForRepo(workspace,…).
env.source = { git: "https://github.com/acme/api", ref: "main", via: "workspace-github-app" }
```

`apps/api/src/execute-case.ts` gains one branch: if the source is a workspace-github-app source, mint
an installation token (by workspace) instead of pulling a personal connection token. The CI-link repo
picker (`ci-link-service.ts listRepos`) switches from the personal token to the installation's
`GET {apiBase}/installation/repositories`.

## Auth / authz

- **Install / register-GHE-app / unlink / set-mattermost** = admin (`settings:write`), same gate as
  today's `integrations` (workspace app config). Reads = `members:read` / `settings:read`.
- No new `Authenticator` — we are the outbound client. (Contrast: GitHub Actions OIDC federation in
  `github-actions-trigger.md` stays as-is.)
- **Mattermost registration = admin (`settings:write`).** "Self-serve from the web" is satisfied by
  admin-in-web (no operator/ops ticket). Full two-way inherently requires MM-side admin actions
  (create bot, register the `/assay` slash command), so a lighter member-level gate wouldn't help —
  resolved to admin.

## Install / link flow (S2) — mirrors the connections callback

- `POST /workspace/github-app/install/start` → `{ installUrl }` =
  `https://github.com/apps/{slug}/installations/new?state={s}` (github.com) or the GHE equivalent.
  Admin clicks → GitHub install page → **picks repos** → GitHub redirects to our callback.
- public `GET /workspace/github-app/callback?installation_id&setup_action&state` → verify state →
  append an installation record to the workspace → 302 to `/{ws}/settings?tab=integrations`.
- `GET /workspace/github-app` → registrations + installations + each installation's selected repos
  (via installation token → `/installation/repositories`). No secrets returned.
- `DELETE /workspace/github-app/installations/{id}` → forget the record (actual uninstall is on
  GitHub). `POST /workspace/github-app/registrations` (GHE App creds) + `DELETE …/{host}`.
- **BFF↔MCP parity:** every route has an MCP tool twin (`*_workspace_github_app`), one shared service
  core (`apps/api/src/github-app-service.ts`).

## Mattermost integration (full two-way)

Structurally parallel to the GHE App: a **workspace-registered** corporate Mattermost, admin sets it
up once, all members use it. Difference: Mattermost is bidirectional, so it needs both outbound bot
calls and **inbound endpoints**.

**Registration (admin, `settings:write`, self-serve web form).** The admin pastes: MM `host`, a
**bot access token**, and (for inbound) a **slash-command token**. Assay stores the tokens as
SecretStore name-refs and, in return, **shows the admin the URLs/commands to register on the MM
side** (same pattern as showing the OAuth callback URL today):
- Slash command `/assay` → `POST {API_PUBLIC_URL}/integrations/mattermost/command?t={inboundToken}`
- Interactive actions → `{API_PUBLIC_URL}/integrations/mattermost/action?t={inboundToken}`

`inboundToken` is an opaque Assay-minted value embedded in those URLs; every inbound request carries
it → **routes the request to the right workspace** (multi-tenant inbound with no user session).

**Outbound (Assay → MM), bot token + REST API** (`/api/v4/posts`):
- Completion / regression / CI / digest notifications (thread-aware).
- Interactive messages: message `attachments[].actions` buttons (Re-run / View scorecard / Compare /
  Acknowledge).

**Inbound (MM → Assay), two verified public endpoints:**
- `POST /integrations/mattermost/command` — `/assay run|leaderboard|status …` → parse → dispatch →
  respond (ephemeral or in-channel/threaded).
- `POST /integrations/mattermost/action` — button click → perform action → update the message.
- **Verification:** each request carries MM's `token` field → constant-time compare against the
  workspace's `commandTokenSecretName` value; `inboundToken` (URL) selects the workspace. Fail-closed.

**AuthZ for chat-triggered actions.** Inbound requests have no OIDC user. Model it like CI: a
workspace-scoped **`chat` principal** (`via: mattermost`, roles limited to `scorecards:run/read` +
reads — never admin), added as a composed `Authenticator` branch keyed off the verified inbound
token. **Optional later:** map the MM user (by email) → an Assay identity so runs are attributed to
the real person; v1 uses the service principal.

## Slice plan (replace-first, remove-last)

Each slice: doc touch if it changes a convention + BFF↔MCP parity + tests. Quality gate
(format/lint/typecheck/test/build) green per slice.

- **S0 — this doc.**
- **S1 — App core (no UI):** operator env (`GITHUB_APP_ID/PRIVATE_KEY/SLUG`) + `github-app.ts`
  (App JWT → installation token, host-aware, repo-restricted) + `WorkspaceSettings.githubApp` schema
  + unit tests (mocked GitHub). Proof: mint a repo-scoped installation token.
- **S2 — install/link API + MCP + authz:** start/callback/list/unlink + GHE registration. Settings →
  통합 deep-link target.
- **S3 — repo-source wiring:** `env.source` workspace-github-app source resolved by workspace in
  `execute-case.ts`; CI-link picker → `/installation/repositories`. **Live private-repo clone verify**
  (github.com + one GHE if reachable).
- **S4 — Web UI:** Settings → 통합 "GitHub App(조직)" section (install / registrations / selected
  repos / unlink) + repo-source picker offering workspace installations.
- **S5 — Mattermost M1 (outbound bot + registration):** workspace registration (`mattermost` block,
  host + bot token, self-serve web form) + switch the completion/regression notifier from
  personal-token post to **bot REST API** (`/api/v4/posts`, thread-aware). Replaces the old
  `notify.connectionId`. **Notifications keep working throughout.**
- **S6 — Clean-migrate the personal-connection consumers to the App, then remove (last).** Removing
  personal connections would break two shipped features that use a personal GitHub token
  (`ci-link-service`: repo picker + setup-PR + runner registration token). So migrate first, then
  delete. Sub-slices:
  - **S6a — GitHub App capability foundation (additive):** extend `GithubAppService` with
    `listRepos(workspace)` (`GET /installation/repositories` across installations),
    `tokenForRepository(workspace, "owner/name", permissions)` (configurable perms — contents:write +
    pull_requests:write for setup-PR), and `runnerRegistrationToken(workspace, target)` (installation
    token w/ administration → `…/actions/runners/registration-token`). App permissions widen
    accordingly. Tests; no rewire yet.
  - **S6b — Rewire `ci-link-service` + runner self-registration to the App:** picker/setup-PR/runner
    token resolve by **workspace installation** (drop `owner, connectionId`); routes/MCP/web
    (ci-links picker, workspace-runners) drop the connection param.
  - **S6c — Remove personal Connected accounts:** delete `ConnectionService`/`ConnectionStore`/
  OAuth `integrations`/routes (`/connections*`, `/workspace/applications`, `/workspace/integrations`)/
  MCP tools/web `manage-connections` + `entities/connection` + account "연결된 계정" tab +
  applications roster + `GITHUB_OAUTH_CLIENT_ID/SECRET` env. Add `assay_connections` **drop
  migration** (expand→contract; preflight note). Retire `docs/connections.md`. Keep
  `API_PUBLIC_URL`/`WEB_BASE_URL` (the App install callback + Mattermost inbound URLs use them).
- **S7 — Mattermost M2 (interactive):** outbound interactive messages (attachment `actions` buttons:
  Re-run / View scorecard / Compare / Acknowledge) + inbound `POST /integrations/mattermost/action`
  (verified, workspace-scoped via `inboundToken` + `commandTokenSecretName`) to handle clicks.
- **S8 — Mattermost M3 (slash commands):** inbound `POST /integrations/mattermost/command`
  (`/assay run|leaderboard|status …`) → dispatch → threaded response. Introduces the workspace-scoped
  `chat` principal (`via: mattermost`, limited roles); optional MM-user→identity mapping by email.

## Rollout / safety

- **Order guarantees no broken window:** repo access (S1–S4) and notifications (S5) are fully live
  before the personal feature is removed (S6).
- **DB:** additive JSONB in S1–S5 (ships normally); the `assay_connections` DROP in S6 is
  contract-phase with a `docs/migration/preflight/` note (verify no code references the table first).
- **Secrets:** GHE App private key + Mattermost webhook URL are SecretStore name-refs — never in git,
  never returned by any surface. App private key (github.com) is operator env, treated like the KEK.

## Non-goals

- Inbound GitHub App **webhooks** / push-triggered eval (stays deferred in `github-actions-trigger.md`).
- Migrating existing personal tokens into installations (users re-install the App; personal tokens are
  simply dropped in S6).
- GitLab/Bitbucket (out of scope).
