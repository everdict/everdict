---
paths: "packages/auth/**,apps/api/src/server.ts,apps/api/src/main.ts,deploy/keycloak/**"
---
# Auth-core rules (push)

The **control plane owns all auth** — `@assay/auth` resolves identity, `apps/api` enforces it. The web is a
token courier, never an auth authority. See `docs/auth.md`.

- **One identity type:** every credential resolves to a `Principal{ subject, workspace, roles, via }`.
  `workspace === tenant === trust-zone key` — never introduce a second tenancy axis; scope every read/write to
  `principal.workspace`.
- **Two authenticators, composed.** `oidcAuthenticator` (Keycloak JWT) + `apiKeyAuthenticator` (`ak_…`) behind
  the one `Authenticator` interface via `compositeAuthenticator`. Add a new credential kind as another
  `Authenticator`, not as a special case inside a route.
- **Fail-closed, always.** Unknown key / bad signature / wrong issuer / expired ⇒ `authenticate` returns
  `undefined` ⇒ **401**. Never let an unverifiable token through. Verify JWTs with **`jose`** against the realm
  **JWKS** (`jwtVerify` with `issuer` + optional `audience`) — never decode-without-verify.
- **Secrets:** store only the **SHA-256 hash** of an API key (`@assay/db`); plaintext is returned **once** at
  issuance. `/internal/**` is guarded by `x-internal-token` (constant-time compare, fail-closed if unset).
- **AuthZ is a flat matrix** (`authz.ts`): `can`/`authorize(principal, action)`; `authorize` throws
  `ForbiddenError` → **403**. Roles are cumulative (`admin ⊃ member ⊃ viewer`). Gate every mutating route;
  reads of another workspace's resource return **404** (no existence leak), not 403.
- **Role mapping:** OIDC roles = `realm_access.roles ∩ assay roles`, empty ⇒ `viewer`; workspace = `workspace`
  claim, else group fallback under `groupPrefix`. Keep these pure and unit-tested with locally-minted JWTs
  (`SignJWT` + `createLocalJWKSet`) — no live Keycloak in tests.
- **Dev fallback** (`x-assay-tenant` → admin) is allowed **only** when `ASSAY_REQUIRE_AUTH` is unset. In any
  deployed config set `ASSAY_REQUIRE_AUTH=1` so a missing bearer is 401.
- **Keycloak fixtures** (`deploy/keycloak/realm-assay.json`) are imported via `--import-realm`. A user missing
  `firstName`/`lastName`/`email` is *"not fully set up"* and ROPC fails — keep fixtures complete. The
  `workspace` protocol mapper (user attribute → claim) is what `oidcAuthenticator` reads; don't drop it.
