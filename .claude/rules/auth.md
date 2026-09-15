---
paths: "packages/auth/**,apps/api/src/composition/authenticator.ts,apps/api/src/api/route-context.ts,apps/api/src/server.ts,apps/api/src/main.ts,deploy/keycloak/**"
---
# Auth-core rules (push)

The **control plane owns all auth** — `@everdict/auth` resolves identity, `apps/api` enforces it. The web is a
token courier, never an auth authority. See `docs/auth.md` + `docs/tenancy.md`.

- **One identity type.** Every credential resolves to a `Principal` (`@everdict/domain`).
  `workspace === tenant === trust-zone key` — never a second tenancy axis; scope every read/write to
  `principal.workspace`. The opaque `subject` is the identity key; `email`/`name` are OIDC display metadata only.
- **Keycloak authenticates; membership authorizes.** `oidcAuthenticator` returns `roles: []` and deliberately
  ignores `realm_access.roles` — never map a token role onto an Everdict role. The role comes from the
  `WorkspaceStore` membership, resolved per request in ONE place, `applyActiveWorkspace`: the
  `x-everdict-workspace` header selects a membership; the token `workspace` claim (else the first group under
  `groupPrefix`) is only the bootstrap default, promoted to a `member` row; no claim leaves `workspace: ""` for
  onboarding, not a 401. A human becomes admin only by creating the workspace (`POST /workspaces`), an invite or a
  promotion. A non-member selection falls back to the default — never a 403.
- **Credential kinds are `Authenticator`s, composed.** `buildAuthenticator` (`apps/api/src/composition/authenticator.ts`)
  chains, in order: `githubActionsAuthenticator` → `oidcAuthenticator` (only when `KEYCLOAK_ISSUER` is set) →
  `apiKeyAuthenticator` (`ak_`) → `agentTokenAuthenticator` (`agt_`) → `runnerAuthenticator` (`rnr_`). Add a new
  kind as another `Authenticator`, never a special case in a route.
  - GitHub Actions stays FIRST: it passes other issuers' JWTs silently, where the Keycloak verifier would log a
    warning. It matches the verified `repository` against the hinted workspace's `WorkspaceSettings.ci.links`
    (`ciLinkTrusting`) and issues `roles: ["ci"]` — `scorecards:read/run` + `harnesses:read/register`, nothing else.
  - `applyActiveWorkspace` returns `via: "runner"` and `via: "github-actions"` principals unchanged — a device or a
    repo must never gain a member row or a member's role.
  - A **personal** API key (`owner` set) resolves AS its issuer (`subject = owner`, base `viewer`) and so carries
    the issuer's membership role — never a blanket admin. A **machine** key (`owner = ""`, from
    `POST /internal/tenant-keys`) is workspace admin (`subject = key:<ws>`). An `agt_` token acts AS its creator,
    capped by its scopes (default `write`).
  - Per-key `scopes` (`read|write|admin`) INTERSECT the role in `can()` — a key never exceeds its issuer. Keys are
    immutable: change permissions by revoke + reissue.
- **Fail-closed, always.** Unknown key / bad signature / wrong issuer / expired ⇒ `authenticate` returns
  `undefined` ⇒ 401. Verify JWTs with `jose` `jwtVerify` (issuer + optional audience) against the JWKS — never
  decode-without-verify.
- **Secrets.** Store only the SHA-256 hash of a key; the plaintext is returned once. `/internal/**` is guarded by
  `x-internal-token` (constant-time compare, fail-closed if unset). Key management (`/keys` + MCP
  `create/list/revoke_api_key`) is self-scoped with no role gate: each user lists, issues and revokes only their own.
- **AuthZ is a flat matrix** (`packages/domain/src/auth/authz.ts`): `can`/`authorize(principal, action)`, 403 on
  deny. `admin ⊃ member ⊃ viewer`; `ci` is its own narrow set. `harnesses:register`, `templates:write` and
  `runtimes:write` are deliberately viewer+ (collaborative content) — don't "fix" them. Gate every mutating route;
  another workspace's resource reads **404**, never 403.
- **The workspace is the only boundary.** The team axis is gone (migrations `0211`/`0212`): `can` asks the role and
  the key scope, nothing more — never reintroduce a per-resource scope parameter. Where an id is GLOBAL (a
  scorecard, a run), the door asks whose it is (`scorecardIsOurs` / `runVisible`); `pnpm guard-siblings` holds
  every door to it.
- **Ownership overrides live in the service, not the matrix.** For "admin or creator", the admin half is the matrix
  action (`datasets:delete`) and the creator half is `assertCanDeleteVersion`
  (`packages/application-control/src/versioned-resource/versioned-resource-delete.ts`), shared by both transports.
  A purely owner-gated action has no matrix action: `DELETE /workspace` skips `gate()` and `WorkspaceService`
  compares `WorkspaceRecord.owner` to the subject.
- **Dev fallback** (`x-everdict-tenant` → admin) exists only while `EVERDICT_REQUIRE_AUTH` is unset, and MCP never
  falls back. Every deployed config sets `EVERDICT_REQUIRE_AUTH=1`.
- **Tests and fixtures.** Mint JWTs locally (`SignJWT` + `createLocalJWKSet`) — no live Keycloak in tests. Users in
  `deploy/keycloak/realm-everdict.json` need `firstName`/`lastName`/`email` or ROPC fails; keep its `workspace`
  protocol mapper, which supplies the bootstrap workspace claim.
