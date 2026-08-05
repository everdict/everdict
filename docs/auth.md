# Auth core (control-plane owned)

**The control plane owns all authentication and authorization.** `@everdict/auth` resolves identity and
`apps/api` enforces it on every route. The Next.js web app (`apps/web`) is **not** part of the auth core —
it logs a human in against Keycloak and forwards the resulting token; it never decides who you are or what
you may do. Agents, MCP, and CI never touch the web at all.

## Two identities, one Principal
Two complementary credentials map to the **same** internal identity:

| Caller | Credential | `via` |
|---|---|---|
| Human (through `apps/web`) | Keycloak **OIDC** access token (JWT) | `oidc` |
| Agent / MCP / CI | **API key** `ak_…` (`Authorization: Bearer ak_…`) | `api-key` |

Both resolve to a `Principal`:

```ts
interface Principal {
  subject: string;        // user id (oidc) or "key" owner — identity key
  workspace: string;      // = tenant = trust-zone key
  roles: string[];        // everdict roles: viewer | member | admin
  via: "oidc" | "api-key";
  email?: string;         // oidc email/preferred_username — display only (member list), never authz/identity; absent for api keys
}
```

`workspace` is the **single tenancy axis**: `workspace === tenant === trust-zone key`. Everyone in a workspace
shares the same isolation zone (same hardened runtime + namespace + warm-pool keying — see
`docs/execution-backends.md`). The runtime is already keyed by `tenant`; the auth core simply supplies a
*real, non-spoofable* `workspace` for that key.

## `@everdict/auth`
One `Authenticator` interface, two impls, composed:

```ts
interface Authenticator { authenticate(bearer: string): Promise<Principal | undefined>; }
compositeAuthenticator([oidc, apiKey])   // tries each; first success wins; undefined ⇒ 401
```

- **`oidcAuthenticator({ issuer, audience?, jwksUri?, workspaceClaim?, groupPrefix?, keySet? })`** — verifies
  the JWT with **`jose`** against the realm's **JWKS** (`createRemoteJWKSet` + `jwtVerify`, checking `issuer`
  and optional `audience`). It only attempts JWT-shaped bearers (3 dot-segments, not `ak_`). Mapping:
  - **workspace** ← the `workspace` claim, else falls back to a group under `groupPrefix`
    (`/workspaces/<ws>/…` → `<ws>`).
  - **roles** ← `realm_access.roles` **intersected with everdict roles** (`viewer|member|admin`); empty ⇒ `viewer`.
- **`apiKeyAuthenticator({ keyStore, roles? })`** — only attempts `ak_…` bearers; `keyStore.resolveByHash(hashKey(bearer))`
  → `{ workspace, scopes? }`. Keys carry `roles` (default `["admin"]`) **and** optional per-key `scopes`
  (`read|write|admin`, cumulative; `admin` = Full Access). `scopes` flow onto the `Principal`; `can()` applies them as
  an **intersection** with the role matrix (a scoped key can never exceed its role). A key with no stored scopes
  (legacy / Full Access via `["admin"]`) is unrestricted — same as before. Scope→action mapping (`SCOPE_PERMISSIONS`)
  lives in `authz.ts` next to `ROLE_PERMISSIONS`: `read` = data reads (not `secrets`/`keys`/`settings`); `write` =
  read ∪ content mutations (run/register/version-create/run); `admin` = all actions.

Verification is **fail-closed**: an unknown key, a bad signature, a wrong issuer, or an expired token all return
`undefined` → the API answers **401**. Only the SHA-256 **hash** of an API key is ever stored (`@everdict/db`); the
plaintext is shown once at issuance.

## Authorization (`authz.ts`)
A flat role → action matrix; `can(principal, action)` / `authorize(principal, action)` (throws `ForbiddenError`
→ **403**):

| Action | viewer | member | admin |
|---|:--:|:--:|:--:|
| `runs:read` | ✓ | ✓ | ✓ |
| `harnesses:read` | ✓ | ✓ | ✓ |
| `runs:submit` |   | ✓ | ✓ |
| `harnesses:register` |   |   | ✓ |

Roles are cumulative (`member` ⊃ `viewer`, `admin` ⊃ `member`).

### The team axis (write = the roster, read = team privacy)
The role says what you may DO; the owning team says what you may do it TO. Every eval asset (harness · dataset ·
judge · rubric · runtime · model · agent) and every result (scorecard · run) records a `teamId` beside its
`createdBy` (migration `0106`); a project names several (`teamIds`). It is a column, never a field inside a
versioned spec, because transferring a team must not mint a new version of something whose content did not change.

The axis answers two different questions, and conflating them was a bug worth naming:

- **WRITING another team's asset is refused** — `can(principal, action, { teamId })` → `canReachTeam`, 403. A
  team's work is theirs to change, and the roster is what says who "they" are. An explicit claim about another
  team (`teamId` in the body) is refused rather than quietly redirected.
- **READING is not membership's business.** A workspace whose teams cannot see each other's work has stopped
  being one workspace: a member of Web could not reuse the judge Mobile wrote, and a goal's projects were
  readable while the evaluations proving them answered "not found" on the same screen. So everything a team owns
  is visible by default, and the narrowing is the team choosing to be **private** (`isPrivate`, migration `0113`)
  — an explicit, per-team opt-in, exactly Linear's model.

Privacy is decided in ONE place, `TeamService.visibleTeamIds(tenant, subject, isAdmin)` / `canSeeTeam(...)`, and
never re-derived in a route. `undefined` from it means "nothing is hidden" — never "no teams", which is the
failure mode a `[]` would silently produce. The API layer wraps it as `visibleTeamsFor` / `teamCeiling` /
`assertTeamVisible` / `assertEntityVisible` (`apps/api` `common/team-scope.ts`), and the pure predicates
`ownedByVisibleTeam` / `ownedByAnyVisibleTeam` (`@everdict/domain`) apply it to a loaded row.

- A refused read answers **404**, never 403 — a private team must not be discoverable by the shape of the error.
- `teamId: undefined` means unowned, which means the workspace's (`_shared` seeds, operator rows, anything from
  before the axis). Never read "no owner" as "everyone's team" in the other direction.
- An ADMIN reaches every team (one they are not on would otherwise be un-administrable), and so does a MACHINE
  credential acting for the workspace (`via ∈ {runner, github-actions}`) — a paired device and a repo-linked CI
  token have no roster to be isolated by. An `agent` credential is NOT exempt: it acts as its creator.
- **Aggregates are counted over everything, listings are narrowed.** An initiative's progress is one number for
  everybody — "how far along is this goal" stops meaning anything if it depends on who asks — but the projects
  and blockers it NAMES are only the ones the reader may see. A total identifies nothing; a name does.
- **What a new asset gets**: `teamForNew` separates the owner it WILL get from what the gate checks — only an
  EXPLICIT choice is authorized, an implicit fallback is the caller's team, else the workspace's default. A
  scorecard resolves one step earlier: an explicit choice → **the team that owns the harness it runs** → the
  submitter's team. That middle step is what gives a schedule, a CI token or a chat command an owner at all.
- **Ownership is TRANSFERABLE, and the transfer is its own act.** `POST /<resource>/:id/team` +
  `move_<resource>` (harness · harness template · dataset · judge · scorecard; an issue's is `POST
  /issues/:id/team` / `move_issue`, which additionally re-mints its identifier). Teams split and work is handed
  over, so an asset filed under the wrong team on a Tuesday must not stay there forever — visible to the wrong
  people and editable by the wrong people. Three rules make it safe:
  - **BOTH teams are authorized** — the source (or moving something out of a team you are not on would be a way
    to take it) and the destination (or this becomes a way to push work into other teams' hands, and if that team
    is private, out of your own sight). An admin passes both; an unowned asset has no source to authorize.
  - **The ENTITY moves, not one version.** Reads already answer ownership off the newest version
    (`teamOfEntity`), so a split id would change owner on its next release. Tombstoned versions move too, or a
    revived one would reappear under the previous team. A transfer mints **no version**: ownership is metadata
    beside `created_by`, so content immutability is untouched.
  - **No new action.** It gates on the resource's existing content-mutation action (`datasets:write`,
    `harnesses:register`, `templates:write`, `judges:write`, `scorecards:run`) — whoever may change a thing may
    re-file it. The core is `moveCapabilityToTeam` (`@everdict/application-control`), one core for both
    transports; a `_shared` first-party asset is **404** (not a workspace's to re-file) and a no-op move is 409.
  A capability's transfer does NOT drag its past scorecards along — evidence is re-filed separately, because a
  result belongs to whoever ran it.

## How `apps/api` enforces it
`resolvePrincipal(req)` is called by **every** route:
1. `Authorization: Bearer <token|ak_…>` → `authenticator.authenticate(...)`; on `undefined` → **401**.
2. No bearer + `EVERDICT_REQUIRE_AUTH=1` → **401**.
3. No bearer in **dev** (default) → fallback `Principal{ subject:"dev", workspace: x-everdict-tenant||"default",
   roles:["admin"] }` so local work needs no Keycloak.

Then each route gates with `authorize(principal, action)` and scopes data to `principal.workspace`:

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` | `/me` | — | returns the resolved `Principal` (web/agent uses it to gate UI) |
| `POST` | `/runs` | `runs:submit` | submits under `principal.workspace` |
| `GET` | `/runs`, `/runs/:id` | `runs:read` | other workspaces' runs → **404** (not 403 — no existence leak) |
| `POST` | `/harnesses` | `harnesses:register` | registered under `principal.workspace` (immutable → 409) |
| `GET` | `/harnesses`, `/harnesses/:id` | `harnesses:read` | workspace-owned + `_shared` |
| `GET`/`POST` | `/workspaces` | — | self-serve membership: list my workspaces / create one (creator = admin) |
| `POST` | `/internal/tenant-keys` | — | operator-only; `x-internal-token` (constant-time, fail-closed); body `{workspace}`; returns the plaintext key **once** |

**Active workspace (multi-workspace).** A subject can be a member of several workspaces. After identity is
resolved, `applyActiveWorkspace` (`server.ts`) picks the active one: the `x-everdict-workspace` header (the web
forwards it from a httpOnly cookie / sidebar switcher) selects a membership and `Principal.workspace`+`roles`
come from it; the token's `workspace` claim is the **bootstrap default** (lazily promoted to a membership on
first use, so existing Keycloak users are seamless). A non-member selection **falls back** to the default —
never a 403 from a stale cookie. Workspace is still the **single tenancy axis**; this only chooses *which* one is
active. Membership SSOT = `@everdict/db` `WorkspaceStore`. See `docs/tenancy.md`.

Wire-up (`apps/api/src/main.ts` → `buildAuthenticator`): `oidcAuthenticator` is added **iff** `KEYCLOAK_ISSUER`
is set (+ optional `OIDC_AUDIENCE`, `WORKSPACE_CLAIM`); `apiKeyAuthenticator` is always present; the two are
composed.

```bash
KEYCLOAK_ISSUER=http://localhost:8081/realms/everdict \
EVERDICT_REQUIRE_AUTH=1 EVERDICT_INTERNAL_TOKEN=… DATABASE_URL=… \
  node apps/api/dist/main.js
```

Plain `node` does **not** auto-load any `.env` (only Next.js does, for the web) — so the control plane sees env
only from the shell. For local dev, put the vars in `apps/api/.env` and run from the repo root with
`pnpm api` (or `pnpm api:dev` for `--watch`, `pnpm api:start` to build first). These use
`node --env-file-if-exists=apps/api/.env`, so the file fills in **unset** vars only — a real env var (k8s secret)
always wins, and a missing file is a no-op (prod-safe). At boot the server logs whether the OIDC verifier was
wired (`▶ auth: OIDC(JWT) verifier enabled issuer=…`) — if you see `KEYCLOAK_ISSUER unset` instead, the env didn't reach
the process.

### Diagnosing 401s (control-plane logging)
The control plane runs a structured (pino) request logger at `EVERDICT_LOG_LEVEL` (default `info`; set `silent` to
disable). It is built to make a Keycloak-token 401 self-explanatory — the common failure when the **web** is wired
to an SSO but the **control plane** isn't:
- **Boot:** logs `▶ auth: OIDC(JWT) verifier enabled issuer=<X>` when `KEYCLOAK_ISSUER` is set, or a loud
  `▶ auth: KEYCLOAK_ISSUER unset — … Internal SSO access tokens will be 401'd.` when it isn't (root cause #1: the JWT
  verifier was never wired, so every SSO token is rejected).
- **Per rejected token:** `oidcAuthenticator`'s `onError` hook logs `▶ auth: OIDC token verification failed [<code>] …` with the
  jose error code (`ERR_JWT_EXPIRED`, claim-validation, signature, **`JWKS_FETCH_FAILED`** = control plane can't
  reach the SSO's JWKS), the **expected issuer vs the token's actual `iss`** (issuer-mismatch is the #2 cause), the
  token `aud`, and the token's top-level claim names (so you can see whether the `WORKSPACE_CLAIM` is even present).
  The token is decoded **unverified**, for diagnostics only.
- **Per request:** `auth: Bearer credential rejected → 401` / `auth: no credential (requireAuth) → 401` / `auth: dev
  fallback (x-everdict-tenant)` — distinguishes "token rejected" from "no token forwarded" from "dev fallback".

`@everdict/auth` itself stays logger-free: the reason is surfaced via the `onError(OidcVerifyErrorInfo)` callback and
`apps/api` decides how to log it (layering: auth is a low-level package, logging is an app concern).

## Keycloak (humans)
`deploy/keycloak/` runs Keycloak and **imports** `realm-everdict.json` (`start-dev --import-realm`):

```bash
KEYCLOAK_PORT=8081 docker compose -f deploy/keycloak/docker-compose.yaml up -d   # 8080 default; override if taken
```

The realm defines:
- realm roles `viewer` / `member` / `admin`;
- groups `/workspaces/{acme,globex}` each carrying a `workspace` attribute (the group-fallback path);
- client `everdict-web` (confidential, standard flow for the web + **direct access grant** for headless testing);
- a **protocol mapper** `workspace` (user attribute → token claim) — this is what `oidcAuthenticator` reads;
- demo users `alice` (member, workspace `acme`) and `carol` (admin, workspace `acme`).

A Keycloak user needs `firstName`/`lastName`/`email` or it is *"not fully set up"* and ROPC fails — keep the
fixture complete.

## Live-verified (real Keycloak)
Token via **ROPC** (browserless), then through the control plane:

```bash
KC=http://localhost:8081/realms/everdict
ALICE=$(curl -s -d grant_type=password -d client_id=everdict-web -d client_secret=everdict-web-secret \
  -d username=alice -d password=alice "$KC/protocol/openid-connect/token" | jq -r .access_token)
curl -s $API/me -H "authorization: Bearer $ALICE"          # {workspace:"acme", roles:["member"], via:"oidc"}
```

Verified end-to-end against a running Keycloak: no token → **401**; forged/expired JWT → **401**;
`alice` (member) → `/me` ok, `POST /runs` **202**, `POST /harnesses` **403**; `carol` (admin) →
`POST /harnesses` **201**.

## Web (BFF token courier — done)
`apps/web` forwards the Keycloak access token as `Bearer` to the control plane: Auth.js's `jwt` callback stores
**and refreshes** `accessToken` in the **server-only httpOnly encrypted cookie** — it is **never placed on the
client session** (the `session` callback exposes only a non-sensitive `error` flag). The server reads it via
`getAccessToken()` (`getToken` over the cookie) and `control-plane.ts` forwards it (falling back to the dev
`x-everdict-tenant` path only when Keycloak is unconfigured). Identity comes from `GET /me` — the web never decodes
the token for `workspace`/roles — and the UI is role-gated off `/me` (`shared/auth/can.ts` mirror), with the
control plane still the enforcer. Live-verified headless via `scripts/live/web-auth-flow.py` (Auth.js + Keycloak
authorization-code flow with a cookie jar): `alice`(member) sees the run form but the harness-register page is
gated; `carol`(admin) sees both; both render `workspace=acme` — and `/api/auth/session` carries **no** access
token (BFF leak check passes) while the server-side path still works. See `docs/web.md`.

## MCP (agent-facing — done)
The agent surface (`apps/api` `/mcp`) is OAuth-protected the same way Linear's MCP is: `/mcp` returns
`401 + WWW-Authenticate: resource_metadata=…`, `/.well-known/oauth-protected-resource` (RFC 9728) names
**Keycloak** as the authorization server, and the MCP client runs OAuth 2.1 + PKCE login. The Bearer is validated
by the **same `compositeAuthenticator`** (Keycloak JWT via JWKS, or `ak_…` API key) → `Principal`, and tools are
role-gated/workspace-scoped. No separate MCP auth path. See `docs/mcp.md`.

## Not yet (next)
- Per-key scopes/expiry, key rotation, self-service signup/plans.
- Further hardening: a service token + signed **acts-as** assertion (the BFF authenticates with its own identity
  and asserts the user) so the user's Keycloak token never traverses the internal wire at all.
```
