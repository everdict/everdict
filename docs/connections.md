# Connected accounts (workspace OAuth connections)

Like Linear's "Connected accounts", a **workspace** connects external providers (**GitHub.com, GitHub
Enterprise, Mattermost**) so Assay can act on its behalf. Unlike Assay's *inbound* OAuth (Keycloak protecting
our own API/MCP), these are **outbound** connections: Assay is the OAuth **client**. Connections are
**workspace-scoped** (shared by all of the workspace's runs/harnesses), mirroring the `SecretStore` model.

Shipped: the **connection lifecycle** (connect → list → disconnect) for all three providers — github.com
(env OAuth App, one-click), GitHub Enterprise + Mattermost (self-hosted: per-connection host + OAuth-app
credentials via the workspace `SecretStore`). The eventual uses — private repo clones (harness seeds),
container image pulls (GHCR/registry), posting results back (PR/status), and channel notifications
(Mattermost) — are later *consumption* slices (Phase 3).

## Model
- Keyed by **`(workspace, id)`**. Metadata: `provider`, `host?` (self-hosted GHE/Mattermost), `accountLabel`
  (e.g. github login), `scopes[]`, `connectedAt`.
- **Tokens encrypted at rest** (`@assay/db` `ConnectionStore`): reuses the same AES-256-GCM `SecretCipher` as
  secrets (KEK from `ASSAY_SECRETS_KEY`, else an auto-generated dev key). DB holds only ciphertext/iv/tag for the
  access (and optional refresh) token.
- **Write-only**: `list` returns metadata only — tokens are **never** returned by the API; `tokenFor` decrypts
  server-side solely for the consumption slices.
- **admin-only** (`connections:read`/`connections:write`) — a connection grants a powerful token (same stance as
  `secrets:*`).
- A provider is **connectable** only if the control plane has its OAuth-app credentials configured (env). With
  none set, the feature degrades to listing/disconnecting existing connections.

## The OAuth dance (control-plane-owned; `client_secret`/tokens never touch the browser)
1. Web "Connect GitHub" → server action → authed `POST /connections/:provider/start` → control plane stores a
   **one-time `state`** (`OAuthStateStore`, expiring) and returns the provider **`authorizeUrl`**.
2. The web client navigates the browser to `authorizeUrl`.
3. Provider → **public** `GET /connections/callback?code&state` on the control plane (no Bearer; authenticated by
   consuming the one-time `state`).
4. Control plane exchanges `code`→token (server-to-server with `client_secret`), calls the provider's "whoami"
   for an `accountLabel`, and stores the encrypted token.
5. Control plane 302s the browser back to `${WEB_BASE_URL}/<workspace>/settings?tab=connections&connected=<provider>`
   (or `…&error=<reason>`). The callback never returns 5xx to the browser — failures become an `error` redirect.

## Manage (API + MCP, same `ConnectionService` core)
| Surface | List | Connect | Disconnect |
|---|---|---|---|
| HTTP | `GET /connections` → `{connections, providers:[{id,selfHosted}]}` | `POST /connections/:provider/start` → `{authorizeUrl}` · `GET /connections/callback` (public, 302) | `DELETE /connections/:id` → 204 |
| MCP | `list_connections` | `get_connect_url {provider, host?, clientId?, clientSecretName?}` → `{authorizeUrl}` (a human opens it; agents can't complete an interactive browser OAuth) | `disconnect_connection {id}` |

The `start` body for **self-hosted** providers carries `{host, clientId, clientSecretName}` (`clientId` is the
public OAuth-app id; `clientSecretName` is a `SecretStore` key — the secret **value** never crosses the wire and
is re-resolved server-side at the callback). github.com needs none of these (env default). `GET /connections`
lists each connectable provider as `{id, selfHosted}` so the web shows a one-click button (github.com) vs a
host+credentials form (GHE/Mattermost).

## Providers
- **github** (github.com): env **OAuth App** (`GITHUB_OAUTH_CLIENT_ID/_SECRET`), one-click. Scopes `repo read:packages`.
- **github-enterprise**: same GitHub impl, host-aware (`https://<host>/login/oauth/…`, API `…/api/v3`). Per-connection
  `host` + `clientId` + `clientSecretName` (SecretStore). No env.
- **mattermost**: OAuth2 (`/oauth/authorize`, form-encoded `/oauth/access_token` → access+refresh+expiry,
  `/api/v4/users/me`). Self-hosted: per-connection `host` + `clientId` + `clientSecretName`. No env. Refresh
  token + expiry persisted in `ConnectionStore`.

## Config (env, control plane)
- `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` — the github.com **OAuth App**. Callback URL must be
  `${API_PUBLIC_URL}/connections/callback`. (GHE/Mattermost need **no env** — their credentials are per-workspace
  `SecretStore` name-refs supplied at connect time.)
- `API_PUBLIC_URL` — externally reachable API base (the provider must reach the callback). If unset, the start
  route falls back to the request host (dev); the MCP `get_connect_url` requires it.
- `WEB_BASE_URL` — where the callback redirects the browser back (default `http://localhost:3001`).

## Phase 3 — consumption (the stored token does real work)
- **Repo clone ✅ (Phase 3a)**: an eval case's repo source can name a connection — `env.source =
  { git, ref, connectionId? }`. At dispatch `RunService` resolves `connectionId` → the connection's token
  (`repoTokenFor` → `connectionStore.tokenFor`) and carries it as a **transient `AgentJob.repoToken`** (never
  persisted to the RunRecord/dataset — the case keeps only the `connectionId` reference). The agent hands it to
  `RepoEnvironment`, which clones the private repo with the token injected as `http.extraheader` via git's
  env-based config (`GIT_CONFIG_*`) — **never in argv** (`ps`/log/`.git/config`-safe). Reachable today via
  `POST /runs` (the body carries a full `EvalCase`) and dataset scorecards; the web run-submit form's
  private-repo picker is a later UX slice (3b).
- **Still open**: image pulls feeding `imagePullSecret` at dispatch (ties into Track B image-source
  integrations); results posted to GitHub PR/status; Mattermost run/scorecard notifications; scorecard-path
  token injection (datasets of private-repo cases) + web submit-form picker.

## Verified
- Deterministic (`packages/db/src/connection-store.test.ts`): token encryption round-trip + `list` exposes no
  token + cross-workspace isolation; `OAuthStateStore` one-time `take` + expiry + self-hosted config carry.
- Providers (`apps/api/src/oauth/github.test.ts`, `mattermost.test.ts`): authorize-URL builders, github.com vs
  GHE host branching (`/api/v3`), GitHub's 200-`{error}` → `UpstreamError`, Mattermost form-encoded exchange +
  refresh/expiry, whoami, non-2xx → `UpstreamError`, missing-host → `BadRequestError`.
- Service (`apps/api/src/connection-service.test.ts`): github.com + self-hosted start→callback round-trips,
  `providerInfos` visibility, SecretStore name-ref resolution (+ missing-secret → `BadRequestError`), one-time/
  invalid state, provider `error`, exchange failure → `error` redirect (no 5xx).
- API (`apps/api/src/server.test.ts`): admin list/start/callback(302)/disconnect end-to-end, self-hosted
  start (missing fields → 400; host reflected in authorizeUrl), **token never returned**, replayed state →
  invalid, unknown provider → 400, viewer → 403.
- MCP (`apps/api/src/mcp.test.ts`): `list_connections`/`get_connect_url`/`disconnect_connection` parity, admin-gated.
- Repo-clone consumption (Phase 3a): `packages/environments/src/repo.test.ts` (private clone injects
  `http.extraheader` via `GIT_CONFIG_*` env, token **not** in argv; public clone has no auth env) +
  `apps/api/src/run-service.test.ts` (`connectionId` → `repoTokenFor` resolved → `job.repoToken`; public/non-git
  cases never call the resolver).
