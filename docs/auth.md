# Auth core (control-plane owned)

**The control plane owns all authentication and authorization.** `@assay/auth` resolves identity and
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
  subject: string;        // user id (oidc) or "key" owner
  workspace: string;      // = tenant = trust-zone key
  roles: string[];        // assay roles: viewer | member | admin
  via: "oidc" | "api-key";
}
```

`workspace` is the **single tenancy axis**: `workspace === tenant === trust-zone key`. Everyone in a workspace
shares the same isolation zone (same hardened runtime + namespace + warm-pool keying — see
`docs/execution-backends.md`). The runtime is already keyed by `tenant`; the auth core simply supplies a
*real, non-spoofable* `workspace` for that key.

## `@assay/auth`
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
  - **roles** ← `realm_access.roles` **intersected with assay roles** (`viewer|member|admin`); empty ⇒ `viewer`.
- **`apiKeyAuthenticator({ keyStore, roles? })`** — only attempts `ak_…` bearers; `keyStore.tenantForHash(hashKey(bearer))`
  → `workspace`. Keys carry `roles` (default `["admin"]`, i.e. full programmatic access for the owning workspace).

Verification is **fail-closed**: an unknown key, a bad signature, a wrong issuer, or an expired token all return
`undefined` → the API answers **401**. Only the SHA-256 **hash** of an API key is ever stored (`@assay/db`); the
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

## How `apps/api` enforces it
`resolvePrincipal(req)` is called by **every** route:
1. `Authorization: Bearer <token|ak_…>` → `authenticator.authenticate(...)`; on `undefined` → **401**.
2. No bearer + `ASSAY_REQUIRE_AUTH=1` → **401**.
3. No bearer in **dev** (default) → fallback `Principal{ subject:"dev", workspace: x-assay-tenant||"default",
   roles:["admin"] }` so local work needs no Keycloak.

Then each route gates with `authorize(principal, action)` and scopes data to `principal.workspace`:

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` | `/me` | — | returns the resolved `Principal` (web/agent uses it to gate UI) |
| `POST` | `/runs` | `runs:submit` | submits under `principal.workspace` |
| `GET` | `/runs`, `/runs/:id` | `runs:read` | other workspaces' runs → **404** (not 403 — no existence leak) |
| `POST` | `/harnesses` | `harnesses:register` | registered under `principal.workspace` (immutable → 409) |
| `GET` | `/harnesses`, `/harnesses/:id` | `harnesses:read` | workspace-owned + `_shared` |
| `POST` | `/internal/tenant-keys` | — | operator-only; `x-internal-token` (constant-time, fail-closed); body `{workspace}`; returns the plaintext key **once** |

Wire-up (`apps/api/src/main.ts` → `buildAuthenticator`): `oidcAuthenticator` is added **iff** `KEYCLOAK_ISSUER`
is set (+ optional `OIDC_AUDIENCE`, `WORKSPACE_CLAIM`); `apiKeyAuthenticator` is always present; the two are
composed.

```bash
KEYCLOAK_ISSUER=http://localhost:8081/realms/assay \
ASSAY_REQUIRE_AUTH=1 ASSAY_INTERNAL_TOKEN=… DATABASE_URL=… \
  node apps/api/dist/main.js
```

## Keycloak (humans)
`deploy/keycloak/` runs Keycloak and **imports** `realm-assay.json` (`start-dev --import-realm`):

```bash
KEYCLOAK_PORT=8081 docker compose -f deploy/keycloak/docker-compose.yaml up -d   # 8080 default; override if taken
```

The realm defines:
- realm roles `viewer` / `member` / `admin`;
- groups `/workspaces/{acme,globex}` each carrying a `workspace` attribute (the group-fallback path);
- client `assay-web` (confidential, standard flow for the web + **direct access grant** for headless testing);
- a **protocol mapper** `workspace` (user attribute → token claim) — this is what `oidcAuthenticator` reads;
- demo users `alice` (member, workspace `acme`) and `carol` (admin, workspace `acme`).

A Keycloak user needs `firstName`/`lastName`/`email` or it is *"not fully set up"* and ROPC fails — keep the
fixture complete.

## Live-verified (real Keycloak)
Token via **ROPC** (browserless), then through the control plane:

```bash
KC=http://localhost:8081/realms/assay
ALICE=$(curl -s -d grant_type=password -d client_id=assay-web -d client_secret=assay-web-secret \
  -d username=alice -d password=alice "$KC/protocol/openid-connect/token" | jq -r .access_token)
curl -s $API/me -H "authorization: Bearer $ALICE"          # {workspace:"acme", roles:["member"], via:"oidc"}
```

Verified end-to-end against a running Keycloak: no token → **401**; forged/expired JWT → **401**;
`alice` (member) → `/me` ok, `POST /runs` **202**, `POST /harnesses` **403**; `carol` (admin) →
`POST /harnesses` **201**.

## Not yet (next)
- **Web rewiring** — `apps/web` forwards the Keycloak access token as `Bearer` to the control plane (Auth.js
  `jwt` callback stores `accessToken`; `control-plane.ts` forwards it instead of `x-assay-tenant`) and gates UI
  off `GET /me`. Until then the web uses the dev `x-assay-tenant` path.
- **MCP** — expose run/harness operations as MCP tools inside `apps/api`, reusing the same `apiKeyAuthenticator`.
- Per-key scopes/expiry, key rotation, self-service signup/plans.
```
