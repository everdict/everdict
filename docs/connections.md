# Connected accounts (personal OAuth connections + workspace roster)

Like Linear's "Connected accounts", a **person** connects external providers (**GitHub.com, GitHub
Enterprise, Mattermost**) so Assay can act on their behalf. Unlike Assay's *inbound* OAuth (Keycloak protecting
our own API/MCP), these are **outbound** connections: Assay is the OAuth **client**. Connections are
**personally owned** (`owner = principal.subject`) — managed on the user's **account** page, visible to that
subject in any workspace (a connection is *not* a workspace asset). Each connection also records the **workspace
it was created in**, so a workspace can show a read-only **applications roster** of the accounts its members have
connected (settings → 멤버 탭). Think Slack: you authorize an app personally; the workspace sees which apps are
connected. (This deliberately diverges from the `SecretStore` model, which stays workspace-scoped.)

Shipped: the **connection lifecycle** (connect → list → disconnect) for all three providers — github.com
(env OAuth App, one-click). For **self-hosted** GitHub Enterprise + Mattermost, a **workspace admin registers
the OAuth app once** (Settings → 통합/Integrations: host + clientId + a `SecretStore` name-ref for the
client_secret), and then **members connect one-click — no client-ID entry** (the genuine Linear experience).
The OAuth-app credentials live in `WorkspaceSettings.integrations` (admin-gated, `settings:write`); the
per-member connect surface (`GET /connections` / `POST …/start` / `get_connect_url`) carries **no** credentials.
The eventual uses — private repo clones (harness seeds), container image pulls (GHCR/registry), posting results
back (PR/status), and channel notifications (Mattermost) — are later *consumption* slices (Phase 3).

## Model
- Keyed by **`(owner, id)`** where `owner = principal.subject` (OIDC `sub`, `key:<ws>` for an API key, or `"dev"`
  in the dev fallback). A non-key column **`workspace`** records where the connection was created (for the roster).
  Metadata: `provider`, `host?` (self-hosted GHE/Mattermost), `accountLabel` (e.g. github login), `scopes[]`,
  `connectedAt`.
- **Tokens encrypted at rest** (`@assay/db` `ConnectionStore`): reuses the same AES-256-GCM `SecretCipher` as
  secrets (KEK from `ASSAY_SECRETS_KEY`, else an auto-generated dev key). DB holds only ciphertext/iv/tag for the
  access (and optional refresh) token.
- **Write-only**: `list`/`listByWorkspace` return metadata only — tokens are **never** returned by the API;
  `tokenFor(owner, id)` decrypts server-side solely for the consumption slices.
- **No role-gating** for personal management. Connections are self-scoped by `subject` (like the profile —
  `PATCH /me/profile`), so **any** authenticated user lists/connects/disconnects **their own** with no role gate;
  the routes scope to `principal.subject`. The `connections:*` actions are **removed** from the authz matrix.
- **Workspace roster is `members:read`.** `GET /workspace/applications` (and MCP `list_workspace_applications`)
  returns the **metadata** roster of connections created in this workspace, gated by `members:read` (viewer+) — it
  surfaces in the settings 멤버 탭, read-only. It never returns tokens and never manages connections.
- **The provider catalog always lists all officially-supported providers** (github / github-enterprise /
  mattermost), each with a `connectable` flag — the web Connected-accounts tab shows every supported service with
  its own Connect button (Linear-style discovery), never hiding the ones that aren't set up yet. A provider is
  `connectable: true` only if its OAuth app is configured: github.com needs the control-plane **env** credentials;
  self-hosted GHE/Mattermost need a **workspace integration** registered by an admin. When `connectable: false` the
  UI shows setup guidance instead of a Connect button — for self-hosted, a deep-link to the workspace 통합 settings
  tab (`/<workspace>/settings?tab=integrations`) if the viewer has `settings:write`, else "관리자 설정 필요"; for
  github.com, an env-app hint. `providerCatalog(workspace)` (one core, both transports — `GET /connections` +
  MCP `list_connections`) computes the flags.
- **Self-hosted OAuth app = workspace asset (admin), not per-connection.** `WorkspaceSettings.integrations`
  (`{ [provider]: { host, clientId, clientSecretName } }`, in the existing `assay_workspace_settings` JSONB) holds
  the admin-registered OAuth app per self-hosted provider. None of these three values is a secret (the
  client_secret **value** lives only in the `SecretStore`, referenced by name), so they are safe to return. This
  is the **one** part of connections that is workspace-scoped + admin-gated; the connection *tokens* stay
  personally owned.

## The OAuth dance (control-plane-owned; `client_secret`/tokens never touch the browser)
1. Web "Connect GitHub" → server action → authed `POST /connections/:provider/start` → control plane stores a
   **one-time `state`** (`OAuthStateStore`, expiring) and returns the provider **`authorizeUrl`**.
2. The web client navigates the browser to `authorizeUrl`.
3. Provider → **public** `GET /connections/callback?code&state` on the control plane (no Bearer; authenticated by
   consuming the one-time `state`).
4. Control plane resolves the provider config — github.com from **env**, self-hosted from the **workspace
   integration** (`pending.workspace` + `provider` → `WorkspaceSettings.integrations[provider]`, client_secret
   re-resolved from the `SecretStore` by name) — exchanges `code`→token (server-to-server with `client_secret`),
   calls the provider's "whoami" for an `accountLabel`, and stores the encrypted token under
   **`owner = pending.createdBy`** (the connecting subject) + the **`workspace`** carried in the pending state.
   The pending state carries **no** credentials (just `{workspace, provider, createdBy}`) — the callback
   re-reads the current workspace integration.
5. Control plane 302s the browser back to `${WEB_BASE_URL}/<workspace>/account?tab=connections&connected=<provider>`
   (or `…&error=<reason>`) — the personal **account** page, not workspace settings. The callback never returns 5xx
   to the browser — failures become an `error` redirect. (`workspace` from the pending state still drives the
   redirect URL + self-hosted credential resolution; only **ownership** is personal.)

## Manage (API + MCP, same `ConnectionService` core)
**Personal connect/disconnect** (self-scoped by `subject`, no role gate) + **workspace roster** (`members:read`):
| Surface | List (personal) | Connect (one-click) | Disconnect | Workspace roster |
|---|---|---|---|---|
| HTTP | `GET /connections` → `{connections, providers:[{id,selfHosted,connectable}]}` (my connections + full provider catalog) | `POST /connections/:provider/start` → `{authorizeUrl}` (**no body credentials**) · `GET /connections/callback` (public, 302) | `DELETE /connections/:id` → 204 | `GET /workspace/applications` → `{connections}` (`members:read`) |
| MCP | `list_connections` | `get_connect_url {provider}` → `{authorizeUrl}` (a human opens it; agents can't complete an interactive browser OAuth) | `disconnect_connection {id}` | `list_workspace_applications` (`members:read`) |

**Workspace integration management** (admin, `settings:read`/`settings:write`) — registers the self-hosted OAuth app:
| Surface | List | Set | Remove |
|---|---|---|---|
| HTTP | `GET /workspace/integrations` → `{providers:[{id,selfHosted,configured,host?,clientId?,clientSecretName?}], callbackUrl?}` (`settings:read`) | `PUT /workspace/integrations/:provider` `{host,clientId,clientSecretName}` → `{providers}` (`settings:write`) | `DELETE /workspace/integrations/:provider` → 204 (`settings:write`) |
| MCP | `list_workspace_integrations` | `set_workspace_integration {provider,host,clientId,clientSecretName}` | `remove_workspace_integration {provider}` |

`GET /connections` lists the **full catalog** as `{id, selfHosted, connectable}` so the web shows every supported
service with its own row (no more host+credentials form on the account page). `connectable: true` → a one-click
Connect button; `connectable: false` → setup guidance (self-hosted: a deep-link to the workspace 통합 tab for
admins, "관리자 설정 필요" for members; github.com: an env-app hint). For self-hosted providers, the Connect button
becomes active only once an admin has registered the workspace integration. `callbackUrl` (the
`${API_PUBLIC_URL}/connections/callback` value the admin must register on the provider's OAuth app) is returned
from the integrations read so the admin UI can display it. Tokens / client_secret **values** are never returned
by any surface.

## Providers
- **github** (github.com): env **OAuth App** (`GITHUB_OAUTH_CLIENT_ID/_SECRET`), one-click. Scopes `repo read:packages`.
- **github-enterprise**: same GitHub impl, host-aware (`https://<host>/login/oauth/…`, API `…/api/v3`).
  Workspace integration: admin registers `host` + `clientId` + `clientSecretName` (SecretStore name-ref) once. No env.
- **mattermost**: OAuth2 (`/oauth/authorize`, form-encoded `/oauth/access_token` → access+refresh+expiry,
  `/api/v4/users/me`). Workspace integration: admin registers `host` + `clientId` + `clientSecretName` once. No
  env. Refresh token + expiry persisted in `ConnectionStore`.

## Config (env, control plane)
- `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` — the github.com **OAuth App**. Callback URL must be
  `${API_PUBLIC_URL}/connections/callback`. (GHE/Mattermost need **no env** — their credentials are per-workspace
  integrations an admin registers in Settings → 통합, with the client_secret as a `SecretStore` name-ref.)
- `API_PUBLIC_URL` — externally reachable API base (the provider must reach the callback). If unset, the start
  route falls back to the request host (dev); the MCP `get_connect_url`/`list_workspace_integrations` `callbackUrl`
  require it.
- `WEB_BASE_URL` — where the callback redirects the browser back (default `http://localhost:3001`).

## Phase 3 — consumption (the stored token does real work)
- **Repo clone ✅ (Phase 3a)**: an eval case's repo source can name a connection — `env.source =
  { git, ref, connectionId? }`. At dispatch `RunService` resolves `connectionId` against the **submitter's
  subject** (`submittedBy`, threaded from `principal.subject`) → the connection's token (`repoTokenFor(owner,
  connectionId)` → `connectionStore.tokenFor`) — i.e. **"clone with *my* connection"** — and carries it as a
  **transient `AgentJob.repoToken`** (never persisted to the RunRecord/dataset — the case keeps only the
  `connectionId` reference). The agent hands it to `RepoEnvironment`, which clones the private repo with the token
  injected as `http.extraheader` via git's env-based config (`GIT_CONFIG_*`) — **never in argv**
  (`ps`/log/`.git/config`-safe). Reachable today via `POST /runs` (the body carries a full `EvalCase`) and dataset
  scorecards. **Consequence of personal ownership:** a `connectionId` only resolves for the user who owns it — so a
  private-repo **dataset** is effectively single-owner (it clones only when its connection's owner submits the
  batch; for anyone else it falls back to a public clone). API-key callers resolve against their own
  `key:<workspace>` subject, a distinct connection set from any human's.
- **Web picker ✅ (Phase 3b)**: the run-submit form (`features/submit-run`) gains a repo-source toggle —
  "빈 작업트리" (default) vs "Git repo (URL)". For git it shows URL + ref + a **connection picker** populated from
  `GET /connections` (filtered to git providers: github/github-enterprise) so a member selects which connected
  account authenticates a private clone (or "none" for public). Enabled by relaxing `connections:read` to viewer+.
- **Batch scorecards ✅ (Phase 3c)**: `ScorecardService` resolves each dataset case's `env.source.connectionId`
  per-case in the dispatch wrapper against the **batch submitter's subject** (same `repoTokenFor(owner,
  connectionId)` → `connectionStore.tokenFor`), so a dataset of private-repo cases batch-evals authenticated **as
  the submitter** — see the single-owner consequence above. Mirrors the single-run path exactly.
- **Mattermost notifications ✅ (Phase 3d)**: a workspace setting `notify = { connectionId, channelId,
  ownerSubject }` (settable via `PUT /workspace/settings`) names a **Mattermost** connection + channel. Because
  connections are now personal, the setter's `subject` is captured **server-side** as `ownerSubject` (the client
  cannot supply it — anti-spoof); the completion notify resolves the token against that owner
  (`tokenFor(ownerSubject, connectionId)`). `NotificationService` posts run **and** scorecard completion
  (`✅/❌`) to `${host}/api/v4/posts`, wired as `RunService`/`ScorecardService` `onComplete` hooks.
  Fire-and-forget — a notify failure never affects the run/scorecard result; **missing `ownerSubject` (legacy
  config)**, non-Mattermost connection, or missing token is silently skipped. (Web config form for the notify
  target is a small follow-up; reachable now via the settings API/MCP.)
- **Still open**: image pulls feeding `imagePullSecret` at dispatch (Track B); results posted to GitHub
  PR/status; web notify-config form.

## Verified
- Deterministic (`packages/db/src/connection-store.test.ts`): token encryption round-trip + `list`/`listByWorkspace`
  expose no token + **owner isolation** + the **workspace roster** (same owner across two workspaces → personal
  `list` sees both, each `listByWorkspace` sees one); `OAuthStateStore` one-time `take` + expiry + self-hosted carry.
- Providers (`apps/api/src/oauth/github.test.ts`, `mattermost.test.ts`): authorize-URL builders, github.com vs
  GHE host branching (`/api/v3`), GitHub's 200-`{error}` → `UpstreamError`, Mattermost form-encoded exchange +
  refresh/expiry, whoami, non-2xx → `UpstreamError`, missing-host → `BadRequestError`.
- Settings store (`packages/db/src/workspace-settings.test.ts`): `integrations` round-trip, setting integrations
  doesn't clobber `notify`/`meterUsage` (top-level merge), host-not-URL rejected, Pg `||` jsonb merge upsert.
- Service (`apps/api/src/connection-service.test.ts`): github.com + self-hosted start→callback round-trips,
  `providerCatalog` flags (all providers always listed; `connectable` flips with env credentials / workspace
  integration), self-hosted
  start **resolves from the workspace integration** (missing integration → `BadRequestError`; missing
  `SecretStore` secret → `BadRequestError`), `setIntegration` rejects non-self-hosted providers,
  `listIntegrations`/`removeIntegration` per-provider read-merge-write (other integrations preserved),
  one-time/invalid state, provider `error`, exchange failure → `error` redirect (no 5xx).
- API (`apps/api/src/server.test.ts`): list/start/callback(302 → `/account`)/disconnect end-to-end, **token never
  returned**, replayed state → invalid, unknown provider → 400, **viewer can list *and* start (no role gate)**;
  self-hosted start with no integration → 400, `GET /connections` hides GHE until configured; integration routes
  `PUT/DELETE /workspace/integrations/:provider` admin-gated (**viewer → 403**), admin set → member one-click
  start (host reflected) + GHE appears in `GET /connections`, **client_secret value never returned**;
  `GET /workspace/applications` roster (`members:read`) shows the connected account.
- MCP (`apps/api/src/mcp.test.ts`): `list_connections`/`get_connect_url {provider}`/`disconnect_connection` parity
  (**no role gate** — personal) + `list_workspace_applications` roster (`members:read`) + integration tools
  `list/set/remove_workspace_integration` (`settings:*`, member → error, secret value never returned).
- Repo-clone consumption (Phase 3a): `packages/environments/src/repo.test.ts` (private clone injects
  `http.extraheader` via `GIT_CONFIG_*` env, token **not** in argv; public clone has no auth env) +
  `apps/api/src/run-service.test.ts` (`connectionId` → `repoTokenFor(owner=submittedBy, …)` resolved →
  `job.repoToken`; public/non-git cases never call the resolver). Batch (Phase 3c):
  `apps/api/src/scorecard-service.test.ts` (per-case `connectionId` → `repoTokenFor(owner, …)` → `job.repoToken`;
  public/non-git cases skip the resolver).
- Notifications (Phase 3d): `apps/api/src/notification-service.test.ts` (posts to Mattermost with
  `tokenFor(ownerSubject, …)` when configured; skips when **no `ownerSubject` (legacy config)** / no config /
  non-Mattermost connection / no token; swallows post failure) + `run-service.test.ts` /
  `scorecard-service.test.ts` (`onComplete` fires with the final record on succeeded **and** failed).
