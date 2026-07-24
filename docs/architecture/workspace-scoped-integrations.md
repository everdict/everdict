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
- **GHE parity:** GitHub Enterprise works **identically to github.com** — one operator-**env** App
  (`GITHUB_ENTERPRISE_APP_*`) for the whole deployment, install-only (no per-workspace App
  registration). The admin just clicks *Install → pick repos*, exactly like github.com. The only
  difference is *which env block holds the App creds* (see the table below), not the UX. (This
  supersedes the earlier per-workspace GHE registration design — the `githubApp.registrations` field
  and its routes/MCP tools/web form were removed.)
- **Mattermost (full two-way):** the corporate Mattermost **server URL is an operator env
  (`MATTERMOST_HOST`)**, shared across the deployment — the self-hosted operator registers it once,
  so workspaces never input a host. A workspace admin then registers only the **bot token** (+
  channel + slash-command token, all SecretStore name-refs) → **outbound** notifications *and*
  **inbound** slash commands + interactive buttons. **Registration is verified against the live
  server (strict):** the bot token must authenticate (`/api/v4/users/me`) and, when a channel is
  given, the channel must be accessible (`/api/v4/channels/{id}`) — a failed connection blocks the
  save (there is also an explicit `POST /workspace/mattermost/probe`). This is Everdict's **first
  inbound integration surface** (verified, workspace-scoped) — a deliberate, contained exception to
  the "no inbound webhooks" stance (which still holds for GitHub App push triggers).
- **Remove personal Connected accounts entirely** (github, github-enterprise, mattermost personal
  connections + the applications roster + the OAuth `integrations`). Done **last**, after the
  replacements are live, so no window breaks repo-clone or notifications.
- **No inbound *GitHub* webhooks.** For GitHub we remain the *client* (mint outbound installation
  tokens); GitHub App push-triggered eval stays deferred (`github-actions-trigger.md`). **Mattermost
  is the deliberate exception** — full two-way needs a verified inbound surface (see the Mattermost
  section below).

## App registration: two homes (both env), one UX

A GitHub App is registered **per GitHub host**, and **both hosts are operator env** — one App per host
for the whole deployment. There is **no per-workspace App registration**; the admin only installs.

| Host | App credentials (App ID + slug + PEM private key), operator env | PEM encoding |
|---|---|---|
| **github.com** | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | base64(PEM) or raw PEM (`\n` restored) |
| **GitHub Enterprise `https://ghe.host`** | `GITHUB_ENTERPRISE_HOST`, `GITHUB_ENTERPRISE_APP_ID`, `GITHUB_ENTERPRISE_APP_SLUG`, `GITHUB_ENTERPRISE_APP_PRIVATE_KEY` | base64(PEM) or raw PEM |

Credential resolution (`GithubAppService.resolveAppCreds`/`resolveInstallTarget`) keys off the install
host: no host → the github.com env App; a host matching `GITHUB_ENTERPRISE_HOST` (normalized `sameHost`)
→ the enterprise env App; any other host → `BadRequest`. The **installation** (the thing that grants
repo access) is workspace-owned in both cases. From the member's perspective the flow is identical:
*install on org → pick repos → workspace can clone them.* The status view exposes `providers:
{ githubCom: boolean, enterprise?: { host } }` so the web renders one install button per configured host.

## Target data model

Everything non-secret lives in `WorkspaceSettings` JSONB (like `integrations` and `ci.links` today);
the only secret (GHE App private key, Mattermost webhook URL) is a **SecretStore name-ref**.

```ts
// packages/contracts/src/records/workspace-settings.ts — WorkspaceSettingsSchema additions
githubApp: z.object({
  // Both github.com AND GitHub Enterprise App creds are operator env → NOT stored here (no registrations field).
  // Workspace-owned installations (github.com + GHE). One per installed org.
  installations: z.array(z.object({
    host: z.string().url().optional(),      // omitted = github.com; set = the enterprise host (GITHUB_ENTERPRISE_HOST)
    installationId: z.number().int(),       // GitHub installation id
    account: z.string().min(1),             // org/user login the app is installed on
    connectedBy: z.string(),                // audit — principal.subject of the admin who linked
    connectedAt: z.string(),
  })).default([]),
}).optional(),

// mattermost: the server URL is operator env (MATTERMOST_HOST) → NOT stored here (host is legacy-optional).
// A workspace stores only the bot/channel/command name-refs; the host is sourced from env at read/post time.
mattermost: z.object({
  host: z.string().url().optional(),             // legacy/optional — no longer written (env-sourced)
  botTokenSecretName: z.string().min(1),         // SecretStore key — bot access token (outbound posts, threads, DMs, interactive)
  commandTokenSecretName: z.string().optional(), // SecretStore key — slash-command/action token (inbound verification)
  defaultChannelId: z.string().optional(),       // default notify channel
  inboundToken: z.string().optional(),           // vestigial (ws-in-URL routing superseded it)
}).nullable().optional(),
```

Installation records hold **no long-lived token** — installation tokens are minted on demand from the
operator-env App private key (github.com or enterprise) and are short-lived (~1h). So no new encrypted
store is needed; JSONB + SecretStore name-refs suffice. `everdict_connections` is **dropped** in S6.
Removing `githubApp.registrations` / stored `mattermost.host` needs no migration — the JSONB fields are
simply no longer read/written (old rows parse and are rewritten without them).

## Token minting (the core)

`apps/api/src/oauth/github-app.ts` (new), host-aware like `github.ts`:

1. **App JWT** — sign `{ iss: appId, iat, exp<=10m }` with RS256 using the App private key.
2. **Installation token** — `POST {apiBase}/app/installations/{id}/access_tokens` with
   `{ repositories: [name], permissions: { contents: "read" } }` → GitHub returns a token **restricted
   to those repos + permissions**, expiring in ~1h.
3. `installationTokenForRepo(workspace, { host?, owner, repo })` resolves the workspace installation
   for that host+owner, loads the App private key from operator env (github.com or, when the host
   matches `GITHUB_ENTERPRISE_HOST`, the enterprise App), mints a token scoped to `owner/repo`, returns it.

This is the **workspace analog of `repoTokenFor`** — resolved by **workspace** (not submitter
subject), so any member's run in the workspace uses it. The transient plumbing is unchanged: the
token is carried as `CaseJob.repoToken` (never persisted), injected into git via `http.extraheader`
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

`apps/api/src/execution/execute-case.ts` gains one branch: if the source is a workspace-github-app source, mint
an installation token (by workspace) instead of pulling a personal connection token. The CI-link repo
picker (`ci-link-service.ts listRepos`) switches from the personal token to the installation's
`GET {apiBase}/installation/repositories`.

## Auth / authz

- **Install / unlink / set-mattermost / probe-mattermost** = admin (`settings:write`), same gate as
  today's `integrations` (workspace app config). Reads = `members:read` / `settings:read`. (There is no
  GHE-app-registration route anymore — both GitHub hosts are operator env.)
- No new `Authenticator` — we are the outbound client. (Contrast: GitHub Actions OIDC federation in
  `github-actions-trigger.md` stays as-is.)
- **Mattermost registration = admin (`settings:write`).** "Self-serve from the web" is satisfied by
  admin-in-web (no operator/ops ticket). Full two-way inherently requires MM-side admin actions
  (create bot, register the `/everdict` slash command), so a lighter member-level gate wouldn't help —
  resolved to admin.
- **Posting a message = member (`mattermost:post`).** Registration is admin governance; *using* the
  registered integration (posting to the channel) is a member action — honestly named as its own action
  (like `images:push`) rather than overloading admin-only `settings:write`. This is what lets a member's
  conversational agent notify the team by default.

## Install / link flow (S2) — mirrors the connections callback

- `POST /workspace/github-app/install/start` → `{ installUrl }` =
  `https://github.com/apps/{slug}/installations/new?state={s}` (github.com) or the GHE equivalent.
  Admin clicks → GitHub install page → **picks repos** → GitHub redirects to our callback.
- public `GET /workspace/github-app/callback?installation_id&setup_action&state` → verify state →
  append an installation record to the workspace → 302 to `/{ws}/settings?tab=integrations`.
- `GET /workspace/github-app` → installations + `providers` (github.com / enterprise, both env) + each
  installation's selected repos (via installation token → `/installation/repositories`). No secrets returned.
- `DELETE /workspace/github-app/installations/{id}` → forget the record (actual uninstall is on GitHub).
  (No registration routes — both GitHub hosts are operator env.)
- **BFF↔MCP parity:** every route has an MCP tool twin (`*_workspace_github_app`), one shared service
  core (`packages/application-control` `GithubAppService`, thin `apps/api/src/api/github-app/*` transports).

## Mattermost integration (full two-way)

A corporate Mattermost whose **server URL is operator env (`MATTERMOST_HOST`)**, shared across the
deployment; a workspace admin registers only the workspace's bot + channel. Mattermost is bidirectional,
so it needs both outbound bot calls and **inbound endpoints**.

**Registration (admin, `settings:write`, self-serve web form).** The server URL is shown read-only (env).
The admin picks the **bot access token** (SecretStore name-ref) + channel + (for inbound) a
**slash-command token**. **Registration is strict — verified against the live server before saving**
(`MattermostClient.verify`: `/api/v4/users/me` for the token + `/api/v4/channels/{id}` for the channel; a
failed connection is a `BadRequest`). There is also an explicit `POST /workspace/mattermost/probe`
(`probe_workspace_mattermost`) that returns a classified `{ reachable, reason?, botUsername?, channelName? }`
— the web's "Test connection" gates Save on a reachable probe. On success Everdict **shows the admin the
URLs/commands to register on the MM side**:
- Slash command `/everdict` → `POST {API_PUBLIC_URL}/integrations/mattermost/command?t={inboundToken}`
- Interactive actions → `{API_PUBLIC_URL}/integrations/mattermost/action?t={inboundToken}`

`inboundToken` is an opaque Everdict-minted value embedded in those URLs; every inbound request carries
it → **routes the request to the right workspace** (multi-tenant inbound with no user session).

**Outbound (Everdict → MM), bot token + REST API** (`/api/v4/posts`):
- Completion / regression / CI / digest notifications (thread-aware).
- Interactive messages: message `attachments[].actions` buttons (Re-run / View scorecard / Compare /
  Acknowledge).
- **Agent-callable post** (`POST /workspace/mattermost/messages` + MCP `post_mattermost_message`, over
  `MattermostService.postMessage`): the conversational agent posts an arbitrary message to the workspace's
  configured default channel as the bot (e.g. "post this regression summary to the team"). Unlike the
  fire-and-forget notification path, failures are **surfaced** (config gaps → `BadRequest`; a transport/non-2xx
  from MM → the adapter's remapped `UpstreamError`) so the agent (and its HITL approver) learns the post's fate.
  Gated `mattermost:post` (**member+**, not admin) — using the integration is a member's job. The agent gets this
  tool **by default** (see `agent-conversations.md` P8: it is one of the curated `INTEGRATION_ACTIONS`, bridged
  HITL-gated).

**Inbound (MM → Everdict), two verified public endpoints:**
- `POST /integrations/mattermost/command` — `/everdict run|leaderboard|status …` → parse → dispatch →
  respond (ephemeral or in-channel/threaded).
- `POST /integrations/mattermost/action` — button click → perform action → update the message.
- **Verification:** each request carries MM's `token` field → constant-time compare against the
  workspace's `commandTokenSecretName` value; `inboundToken` (URL) selects the workspace. Fail-closed.

**AuthZ for chat-triggered actions.** Inbound requests have no OIDC user. Model it like CI: a
workspace-scoped **`chat` principal** (`via: mattermost`, roles limited to `scorecards:run/read` +
reads — never admin), added as a composed `Authenticator` branch keyed off the verified inbound
token. **Optional later:** map the MM user (by email) → an Everdict identity so runs are attributed to
the real person; v1 uses the service principal.

## Slice plan (replace-first, remove-last)

Each slice: doc touch if it changes a convention + BFF↔MCP parity + tests. Quality gate
(format/lint/typecheck/test/build) green per slice.

- **S0 — this doc.**
- **S1 — App core (no UI):** operator env (`GITHUB_APP_ID/PRIVATE_KEY/SLUG`) + `github-app.ts`
  (App JWT → installation token, host-aware, repo-restricted) + `WorkspaceSettings.githubApp` schema
  + unit tests (mocked GitHub). Proof: mint a repo-scoped installation token.
- **S2 — install/link API + MCP + authz:** start/callback/list/unlink + GHE registration. Settings →
  Integrations deep-link target.
- **S3 — repo-source wiring:** `env.source` workspace-github-app source resolved by workspace in
  `execute-case.ts`; CI-link picker → `/installation/repositories`. **Live private-repo clone verify**
  (github.com + one GHE if reachable).
- **S4 — Web UI:** Settings → Integrations "GitHub App (org)" section (install / registrations / selected
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
  - **S6b — Rewire `ci-link-service` + runner self-registration (API) to the App:** picker/setup-PR/
    runner token resolve by **workspace installation** (drop `owner, connectionId`); routes/MCP drop
    the connection param (`GET /workspace/github-app/repos` picker, `open_ci_setup_pr`,
    `github_install_workspace_runner`). The **web** ci-links picker + workspace-runners rewire folds
    into S6c (same surgery as removing the connection concept from the web; web still builds green
    between S6b↔S6c — the CI repo picker just 404s until S6c).
  - **S6c — Remove personal Connected accounts:** delete `ConnectionService`/`ConnectionStore`/
  OAuth `integrations`/routes (`/connections*`, `/workspace/applications`, `/workspace/integrations`)/
  MCP tools/web `manage-connections` + `entities/connection` + account "Connected accounts" tab +
  applications roster + `GITHUB_OAUTH_CLIENT_ID/SECRET` env. Add `everdict_connections` **drop
  migration** (expand→contract; preflight note). Retire `docs/connections.md`. Keep
  `API_PUBLIC_URL`/`WEB_BASE_URL` (the App install callback + Mattermost inbound URLs use them).
- **S7–S8 — Mattermost inbound (slash commands + button actions) — SHIPPED.** Public routes
  `POST /integrations/mattermost/{command,action}` — workspace routed by `?ws=<slug>` (slug not
  secret), authenticated by **constant-time compare** of the request `token` against the workspace's
  `commandTokenSecretName` value (fail-closed: missing config / missing token / mismatch → 403).
  `MattermostCommandService` parses `/everdict run <harness> <dataset>` (submits a scorecard,
  `submittedBy=mattermost:<user>`) · `/everdict leaderboard <dataset>` · `/everdict status` · `help`; the
  action endpoint handles a `rerun` button context. Registration gains `commandTokenSecretName`
  (API + MCP `set_workspace_mattermost` + web form); the view exposes the inbound URLs for the admin
  to register on the MM side. form-urlencoded body parser added for MM slash commands.
  - Chose ws-in-URL routing over a separate `inboundToken` (simpler, still token-verified); the schema
    `inboundToken` field is now vestigial (harmless, unused).
  - Follow-up: **auto-attach** the `rerun` button to outbound completion posts (the action endpoint
    already handles clicks; only the outbound attachment is unwired) + MM-user→Everdict-identity mapping.

## Rollout / safety

- **Order guarantees no broken window:** repo access (S1–S4) and notifications (S5) are fully live
  before the personal feature is removed (S6).
- **DB:** additive JSONB in S1–S5 (ships normally); the `everdict_connections` DROP in S6 is
  contract-phase with a `docs/migration/preflight/` note (verify no code references the table first).
- **Secrets:** GHE App private key + Mattermost webhook URL are SecretStore name-refs — never in git,
  never returned by any surface. App private key (github.com) is operator env, treated like the KEK.

## Non-goals

- Inbound GitHub App **webhooks** / push-triggered eval (stays deferred in `github-actions-trigger.md`).
- Migrating existing personal tokens into installations (users re-install the App; personal tokens are
  simply dropped in S6).
- GitLab/Bitbucket (out of scope).


## Rerun button on completion posts

A scorecard completion post carries an interactive **Rerun** action when the workspace has the inbound half
configured (`commandTokenSecretName`) and the control plane knows its public URL (`API_PUBLIC_URL`): the button
posts back to `/integrations/mattermost/action?ws=<workspace>` with the embedded context (the same verification
token the slash-command inbound checks + the dataset/harness coordinates), and the existing `handleAction`
re-fires dataset×harness from chat. Without either precondition the post stays a plain message — no dead
buttons. Regression alerts stay button-less for now (their payload carries scorecard ids, not rerun
coordinates).
