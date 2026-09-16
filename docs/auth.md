---
kind: wiki
title: "Auth core (control-plane owned)"
status: current
updated: 2026-09-15
anchors: [packages/auth/src/oidc.ts, packages/auth/src/api-key.ts, apps/api/src/composition/authenticator.ts, packages/domain/src/auth/authz.ts, deploy/keycloak/realm-everdict.json]
---
# Auth core (control-plane owned)

**The control plane owns all authentication and authorization.** `@everdict/auth` resolves identity and
`apps/api` enforces it on every route. The Next.js web app (`apps/web`) is **not** part of the auth core —
it logs a human in against Keycloak and forwards the resulting token; it never decides who you are or what
you may do. Agents, MCP, and CI never touch the web at all.

## Every credential, one Principal

| Caller | Credential | `via` |
|---|---|---|
| Human (through `apps/web`) | Keycloak **OIDC** access token (JWT) | `oidc` |
| Agent / MCP / CI with a key | **API key** `ak_…` (`Authorization: Bearer ak_…`) | `api-key` |
| Autonomous agent turn (`apps/agent`) | agent execution token `agt_…` | `agent` |
| Self-hosted runner | runner pairing token `rnr_…` | `runner` |
| GitHub Actions workflow | GitHub-signed OIDC token + `x-everdict-workspace` | `github-actions` |

All of them resolve to a `Principal` (`packages/domain/src/auth/principal.ts`, re-exported by `@everdict/auth`):
`subject` (the identity key), `workspace`, `roles`, `via`, plus optional `email`/`name` (OIDC display metadata
only — never an authz input), `scopes` (per-key narrowing) and `runnerId`. A campaign evidence grant
(`Bearer cpe_…`) resolves to a Principal that may only `GET /campaigns/:id/evidence-view` for its own campaign.

`workspace` is the **single tenancy axis**: `workspace === tenant === trust-zone key`. Everyone in a workspace
shares the same isolation zone (see [execution-backends.md](execution-backends.md)). The runtime is keyed by
`tenant`; the auth core supplies a *real, non-spoofable* `workspace` for that key.

## `@everdict/auth`
One `Authenticator` interface (`authenticate(bearer, ctx?)`, where `ctx.workspaceHint` is the
`x-everdict-workspace` header), several impls, composed by `compositeAuthenticator` — first success wins,
`undefined` from all ⇒ 401. Each impl claims only its own bearer shape:

- **`oidcAuthenticator({ issuer, audience?, jwksUri?, workspaceClaim?, groupPrefix?, keySet?, onError? })`** —
  verifies the JWT with **`jose`** against the realm's **JWKS** (`createRemoteJWKSet` + `jwtVerify`, checking
  `issuer` and optional `audience`). It only attempts JWT-shaped bearers (3 dot-segments, not `ak_`).
  - **workspace** ← the `workspace` claim, else a group under `groupPrefix` (`/workspaces/<ws>/…` → `<ws>`), else
    `""` — a valid token with no workspace still authenticates and is sent to onboarding.
  - **roles** ← **none**. Keycloak is authentication only: `realm_access.roles` is deliberately ignored and the
    Principal carries `roles: []` until the workspace membership supplies one (below).
- **`apiKeyAuthenticator({ keyStore, roles? })`** — `ak_…` only; `keyStore.resolveByHash(hashKey(bearer))`. A
  **personal** key (it has an `owner`, mig `0041`) resolves AS its issuer (`subject = owner`) and takes the issuer's
  membership role — a member's key has member permissions. A **machine** key (no owner, e.g. from
  `/internal/tenant-keys`) is `subject = key:<ws>` with `roles` (default `["admin"]`). Stored `scopes` flow onto the
  Principal.
- **`agentTokenAuthenticator`** — `agt_…`; acts AS the agent's creator (their live membership role), scope
  defaulting to `write` so an autonomous turn never reaches governance or secrets. See
  `docs/architecture/agent-execution-auth.md`.
- **`runnerAuthenticator`** — `rnr_…`; `roles: ["runner"]`, fixed workspace, `runnerId` — least privilege.
- **`githubActionsAuthenticator`** — keyless CI: a GitHub (or trusted GHES) OIDC token is accepted only when its
  repository and ref match a repo link of the workspace the request names; `roles: ["ci"]`. It is first in the
  chain so CI tokens never reach the Keycloak verifier. See `docs/architecture/github-actions-trigger.md`.

Verification is **fail-closed**: an unknown key, a bad signature, a wrong issuer, or an expired token all return
`undefined` → the API answers **401**. Only the SHA-256 **hash** of a key or token is ever stored (`@everdict/db`);
the plaintext is shown once at issuance. Keys have no expiry and are immutable — change permissions by revoke +
reissue.

## Authorization (`authz.ts`)
A flat role → action matrix in `packages/domain/src/auth/authz.ts` (re-exported by `@everdict/auth`);
`can(principal, action)` / `authorize(principal, action)` (throws `ForbiddenError` → **403**). Roles are
`viewer ⊂ member ⊂ admin`, plus the non-member `ci` role (`scorecards:read/run`, `harnesses:read/register`). A
sample of the matrix — the file is the full list:

| Action | viewer | member | admin |
|---|:--:|:--:|:--:|
| `runs:read` · `harnesses:read` · `datasets:read` | ✓ | ✓ | ✓ |
| `harnesses:register` · `templates:write` · `runtimes:write` (collaborative content) | ✓ | ✓ | ✓ |
| `runs:submit` · `scorecards:run` · `datasets:write` · `judges:write` · `models:write` |   | ✓ | ✓ |
| `datasets:delete` · `members:write` · `secrets:write` · `settings:write` · `runtimes:control` |   |   | ✓ |

A key's `scopes` (`read|write|admin`, cumulative; `admin` = Full Access, the default when omitted) apply as an
**intersection**: `read` = data reads (not secrets/keys/settings), `write` = read ∪ content mutations, `admin` =
every action. A scoped key never exceeds its role. A few actions are "admin **or** the resource's creator": the
admin half stays in the matrix and the creator half lives in the service that knows who created the row.

### There is no second ownership axis — the workspace is the boundary

The role says what you may DO. Nothing says what you may do it TO, because everything a workspace holds is the
workspace's.

There WAS a second axis: every eval asset and result recorded a `teamId`, a project named several, writing one
you were not on was refused, and a *private* team narrowed reads. Migrations `0211`/`0212` removed it —
the column from fifteen tables, the roster, the privacy flag, the transfer endpoints, and the `ResourceScope`
parameter `can`/`authorize` took. `can(principal, action)` answers two questions now (does the role grant it,
does the api-key scope still carry it) and there is no third.

What is left, and what it costs to forget it:

- **Tenancy is the whole boundary.** Every read and write is workspace-scoped, and another workspace's resource
  is answered **404**, never 403 — a 403 confirms the id exists.
- **A capability's tenancy is structural.** Registry calls are keyed `(tenant, id, version)` with the tenant
  taken from the caller's own principal, so a door cannot name another workspace's harness at all.
- **A globally-addressed record's is not.** A scorecard id and a run id are uuids that no signature scopes, so
  the door asks before it answers: `scorecardIsOurs` / `runVisible`, 404 on refusal. `pnpm guard-siblings` is
  what stops one door in a resource from forgetting what its neighbours do — it was written when a door gained
  an ownership gate and its sibling did not, and the shape it refuses outlived the axis it was written for.
- **A run has one narrowing that is NOT tenancy**: its own audience (`runAudience` — another member's agent turn
  or shell session answers 404 to you). That is a per-record visibility field, not an ownership axis.

## How `apps/api` enforces it
`resolvePrincipal(req)` (`apps/api/src/api/route-context.ts`) is called by every human/HTTP route:
1. `Authorization: Bearer <token>` → the composed authenticator; on `undefined` → **401**.
2. No bearer + `EVERDICT_REQUIRE_AUTH=1` → **401**.
3. No bearer otherwise (dev) → `Principal{ subject:"dev", workspace: x-everdict-tenant || "default",
   roles:["admin"] }`, so local work needs no Keycloak. The MCP endpoint has no such fallback.

Then **`applyActiveWorkspace`** turns identity into a role. Membership is the role SSOT (`@everdict/db`
`WorkspaceStore`). The token's workspace (claim or dev header) is the **bootstrap default**: a subject with no
membership there gets one — as `member` for a human, since a realm role cannot grant admin on someone else's
workspace. The `x-everdict-workspace` header (the web's active-workspace cookie) selects another membership, and
`roles` become that membership's role; a non-member selection **falls back** to the default — never a 403 from a
stale cookie. Admin comes only from creating a workspace (`POST /workspaces`, creator = admin), an invite, or a
promotion. Runner, GitHub Actions and evidence-grant principals skip this step (a device or a CI repo never gains a
member row). See [tenancy.md](tenancy.md).

Each route then gates with `authorize(principal, action)` and scopes data to `principal.workspace`. The per-route
action is in the generated reference ([api.md](api.md)); the exceptions are: `GET/POST /workspaces` (self-serve,
no role gate), `/keys` (personal and self-scoped — each user lists, issues and revokes only their own keys), and
`/internal/**` (operator-only: `x-internal-token`, constant-time compare, fail-closed when
`EVERDICT_INTERNAL_TOKEN` is unset).

Wire-up (`apps/api/src/composition/authenticator.ts` → `buildAuthenticator`): GitHub Actions first;
`oidcAuthenticator` **iff** `KEYCLOAK_ISSUER` is set (+ optional `OIDC_AUDIENCE`, `WORKSPACE_CLAIM`); API keys,
agent tokens and runner tokens always.

```bash
KEYCLOAK_ISSUER=http://localhost:8081/realms/everdict \
EVERDICT_REQUIRE_AUTH=1 EVERDICT_INTERNAL_TOKEN=… DATABASE_URL=… \
  node apps/api/dist/main.js
```

Plain `node` does **not** auto-load any `.env` (only Next.js does, for the web) — so the control plane sees env
only from the shell. For local dev, put the vars in `apps/api/.env` (template: `apps/api/.env.example`) and run
from the repo root with `pnpm api` (or `pnpm api:dev` for `--watch`, `pnpm api:start` to build first). These use
`node --env-file-if-exists=apps/api/.env`, so the file fills in **unset** vars only — a real env var (k8s secret)
always wins, and a missing file is a no-op (prod-safe).

### Diagnosing 401s (control-plane logging)
The control plane runs a structured (pino) request logger at `EVERDICT_LOG_LEVEL` (default `info`). It is built to
make a Keycloak-token 401 self-explanatory — the common failure when the **web** is wired to an SSO but the
**control plane** isn't:
- **Boot:** logs `▶ auth: OIDC(JWT) verifier enabled issuer=<X>` when `KEYCLOAK_ISSUER` is set, or a loud
  `▶ auth: KEYCLOAK_ISSUER unset — … Internal SSO access tokens will be 401'd.` when it isn't (root cause #1: the JWT
  verifier was never wired, so every SSO token is rejected).
- **Per rejected token:** `oidcAuthenticator`'s `onError` hook logs `▶ auth: OIDC token verification failed [<code>] …`
  with the jose error code (`ERR_JWT_EXPIRED`, claim-validation, signature, **`JWKS_FETCH_FAILED`** = control plane
  can't reach the SSO's JWKS), the **expected issuer vs the token's actual `iss`** (issuer mismatch is the #2
  cause), the token `aud`, and the token's top-level claim names (so you can see whether the `WORKSPACE_CLAIM` is
  even present). The token is decoded **unverified**, for diagnostics only.
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
- realm roles `viewer` / `member` / `admin` (carried by the fixture; the control plane ignores them);
- groups `/workspaces/{acme,globex}` each carrying a `workspace` attribute (the group-fallback path);
- client `everdict-web` (confidential, standard flow for the web + **direct access grant** for headless testing)
  and the public PKCE client `everdict-mcp` (see [mcp.md](mcp.md));
- a **protocol mapper** `workspace` (user attribute → token claim) on both clients — this is what
  `oidcAuthenticator` reads;
- demo users `alice` and `carol` (workspace `acme`) and `dave` (workspace `globex`).

A Keycloak user needs `firstName`/`lastName`/`email` or it is *"not fully set up"* and ROPC fails — keep the
fixture complete.

⚠️ **The realm must declare an unmanaged-attribute policy, or `workspace` never reaches a token** (live incident,
2026-08-11). Keycloak 24+ has a DECLARATIVE user profile and, by default, refuses attributes it does not know: on
import it silently drops `users[].attributes.workspace`, the `workspace` protocol mapper then maps nothing, and every
SSO principal resolves with `workspace: ""` — an authenticated member with no workspace, which reads as "everything
disappeared" rather than as a realm-config fault. The fixture therefore carries a
`components["org.keycloak.userprofile.UserProfileProvider"]` entry with `{"unmanagedAttributePolicy":"ENABLED"}`
(verified by importing the fixture into a throwaway realm and reading the claim back off a minted token). An
`UPDATE`-by-admin-API repair has the same trap in reverse: `PUT /admin/realms/<r>/users/<id>` REPLACES the user, so a
body carrying only `attributes` wipes `email`/`firstName`/`lastName` and the account stops being "fully set up".

Token via **ROPC** (browserless), then through the control plane:

```bash
KC=http://localhost:8081/realms/everdict
ALICE=$(curl -s -d grant_type=password -d client_id=everdict-web -d client_secret=everdict-web-secret \
  -d username=alice -d password=alice "$KC/protocol/openid-connect/token" | jq -r .access_token)
curl -s $API/me -H "authorization: Bearer $ALICE"   # {subject, workspace:"acme", roles:["member"], via:"oidc", workspaces, …}
```

## Web (BFF token courier)
`apps/web` forwards the Keycloak access token as `Bearer` to the control plane: Auth.js's `jwt` callback stores
**and refreshes** `accessToken` in the **server-only httpOnly encrypted cookie** — it is **never placed on the
client session** (the `session` callback exposes only a non-sensitive `error` flag). The server reads it via
`getAccessToken()` (`getToken` over the cookie) and `control-plane.ts` forwards it (falling back to the dev
`x-everdict-tenant` path only when Keycloak is unconfigured). Identity comes from `GET /me` — the web never decodes
the token for `workspace`/roles — and the UI is role-gated off `/me` (`shared/auth/can.ts` mirror), with the
control plane still the enforcer. `scripts/live/web-auth-flow.py` drives the Auth.js + Keycloak
authorization-code flow headlessly with a cookie jar and checks that a signed-in `/api/auth/session` carries
**no** access token; its per-role page assertions match the current matrix and require each gated page to have
rendered before they read the gate. See `docs/web.md`.

## MCP (agent-facing)
The agent surface (`apps/api` `/mcp`) is OAuth-protected the same way Linear's MCP is: `/mcp` returns
`401 + WWW-Authenticate: resource_metadata=…`, `/.well-known/oauth-protected-resource` (RFC 9728) names
**Keycloak** as the authorization server, and the MCP client runs OAuth 2.1 + PKCE login. The Bearer is validated
by the **same composed authenticator** → `Principal`, and tools are role-gated/workspace-scoped. No separate MCP
auth path. See [mcp.md](mcp.md).
