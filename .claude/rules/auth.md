---
paths: "packages/auth/**,apps/api/src/server.ts,apps/api/src/main.ts,deploy/keycloak/**"
---
# Auth-core rules (push)

The **control plane owns all auth** — `@assay/auth` resolves identity, `apps/api` enforces it. The web is a
token courier, never an auth authority. See `docs/auth.md`.

- **One identity type:** every credential resolves to a `Principal{ subject, workspace, roles, via, email? }`.
  `workspace === tenant === trust-zone key` — never introduce a second tenancy axis; scope every read/write to
  `principal.workspace`. `email` is the OIDC `email`/`preferred_username` claim (optional; absent for API keys) —
  **display metadata only** (captured into the membership row for a human-readable member list), never an
  authz/identity input; the opaque `sub` remains the identity key.
- **Multi-workspace membership.** A subject may belong to several workspaces (SSOT = `@assay/db`
  `WorkspaceStore`: `assay_workspaces` + `assay_workspace_members`). The **active** one is resolved per request in
  `apps/api` (`applyActiveWorkspace`): the `x-assay-workspace` header selects a membership (`roles` come from it);
  the token `workspace` claim / dev tenant is the **bootstrap default** (lazily promoted to a membership). A
  non-member selection **falls back** to the default — never a 403 from a stale selection. `POST/GET /workspaces`
  are self-serve (no role gate; creator = admin) with MCP parity (`create_workspace`/`list_workspaces`). Keep
  active-workspace logic in the one `applyActiveWorkspace`, not in routes. See `docs/tenancy.md`.
- **Authenticators, composed.** `githubActionsAuthenticator` (GitHub Actions OIDC federation — keyless CI) +
  `oidcAuthenticator` (Keycloak JWT) + `apiKeyAuthenticator` (`ak_…`) + `runnerAuthenticator` (`rnr_…`) behind
  the one `Authenticator` interface via `compositeAuthenticator`. Add a new credential kind as another
  `Authenticator`, not as a special case inside a route. `authenticate(bearer, ctx?)` carries an optional
  `AuthContext{ workspaceHint }` (the `x-assay-workspace` header) — the GitHub federation matches the verified
  `repository` claim against **that workspace's** repo links (`WorkspaceSettings.ci.links`; link = trust) and
  issues `roles:["ci"]` (scorecards:run/read + harnesses:register/read only). Keep the GitHub authenticator
  FIRST in the chain (it pre-checks `iss` via decode and passes silently) so CI tokens don't spam the Keycloak
  verifier's warn logs. `via ∈ {runner, github-actions}` principals are **excluded from membership bootstrap**
  in `applyActiveWorkspace` (a device/CI repo must never gain a member row). See
  `docs/architecture/github-actions-trigger.md`.
- **Fail-closed, always.** Unknown key / bad signature / wrong issuer / expired ⇒ `authenticate` returns
  `undefined` ⇒ **401**. Never let an unverifiable token through. Verify JWTs with **`jose`** against the realm
  **JWKS** (`jwtVerify` with `issuer` + optional `audience`) — never decode-without-verify.
- **Secrets:** store only the **SHA-256 hash** of an API key (`@assay/db`); plaintext is returned **once** at
  issuance. `/internal/**` is guarded by `x-internal-token` (constant-time compare, fail-closed if unset).
  Key management (`POST/GET/DELETE /keys` + MCP `create/list/revoke_api_key`) is **personal / self-scoped** — no
  role gate (like connections/personal-secrets): each user sees/issues/revokes only their **own** keys (keyed by
  `owner = principal.subject`, migration `0041`). A **personal** key (`owner ≠ ''`) resolves via
  `apiKeyAuthenticator` to the **issuer's** identity (`subject = owner`) and — through `applyActiveWorkspace`
  membership — the **issuer's role** (member key = member perms, base `viewer` if the owner isn't a member); it is
  **never** a blanket workspace-admin. A **legacy/machine** key (`owner = ''`, e.g. `/internal/tenant-keys`) keeps
  the old workspace-**admin** semantics (`subject = key:<ws>`). `list` exposes only non-secret metadata
  (`id`/`prefix`/`label`/`scopes`/`createdAt`), never the hash/plaintext; `revoke` is `(tenant, id, owner)`-scoped
  (can't revoke another user's key). A key may carry per-key **`scopes`** (`read|write|admin`, cumulative; `admin`
  = Full Access, the default when omitted); `apiKeyAuthenticator` loads them via `keyStore.resolveByHash` onto
  `Principal.scopes`, and `can()` applies them as an **intersection** with the role matrix (`SCOPE_PERMISSIONS`) —
  a scoped key never exceeds its issuer's role. Keys are **immutable** — change permissions by revoke + reissue.
- **AuthZ is a flat matrix** (`authz.ts`): `can`/`authorize(principal, action)`; `authorize` throws
  `ForbiddenError` → **403**. Roles are cumulative (`admin ⊃ member ⊃ viewer`). Gate every mutating route;
  reads of another workspace's resource return **404** (no existence leak), not 403.
- **Resource-ownership override (use sparingly).** A few actions are "admin **or** the resource's creator". Keep
  the **admin** half in the flat matrix (e.g. `datasets:delete` = admin-only) and put the **creator** half in the
  service layer that knows who created the row (`dataset-service.ts` `deleteDatasetVersion`: `creatorOf` vs
  `principal.subject`). Don't smuggle per-resource ownership into the role matrix, and don't fork it across
  transports — both the HTTP route and the MCP tool call the one shared service helper. A **purely** owner-gated
  action has **no** matrix action at all: `DELETE /workspace` (`workspace-service.ts` `delete`) compares
  `WorkspaceRecord.owner` to `principal.subject` and the route/MCP tool skip `gate()` entirely (a non-owner admin
  is 403) — the slug is the tenant key, so deleting a workspace is the owner's call, not any admin's.
- **Role mapping:** OIDC roles = `realm_access.roles ∩ assay roles`, empty ⇒ `viewer`; workspace = `workspace`
  claim, else group fallback under `groupPrefix`. Keep these pure and unit-tested with locally-minted JWTs
  (`SignJWT` + `createLocalJWKSet`) — no live Keycloak in tests.
- **Dev fallback** (`x-assay-tenant` → admin) is allowed **only** when `ASSAY_REQUIRE_AUTH` is unset. In any
  deployed config set `ASSAY_REQUIRE_AUTH=1` so a missing bearer is 401.
- **Keycloak fixtures** (`deploy/keycloak/realm-assay.json`) are imported via `--import-realm`. A user missing
  `firstName`/`lastName`/`email` is *"not fully set up"* and ROPC fails — keep fixtures complete. The
  `workspace` protocol mapper (user attribute → claim) is what `oidcAuthenticator` reads; don't drop it.
