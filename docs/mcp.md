# MCP server (agent-facing, OAuth-protected)

The platform's **agent-facing surface**: an MCP server inside `apps/api` that exposes the same operations as the
HTTP API as MCP tools, **authenticated like Linear's MCP** — the client logs in via OAuth and the control plane
validates the token. Humans use the web; agents (Claude Code, CI, custom) use MCP.

## Tools
Streamable-HTTP MCP endpoint at `POST /mcp` (stateful sessions). Each tool runs over the **same service core** as
the HTTP routes (`RunService` + `HarnessRegistry`), is **role-gated** (`authorize(principal, action)`) and
**workspace-scoped**:

| Tool | Action (role) | Effect |
|---|---|---|
| `list_runs` | `runs:read` (viewer+) | the caller's workspace runs |
| `get_run` | `runs:read` | one run (other workspace → `NOT_FOUND`) |
| `submit_run` | `runs:submit` (member+) | submit an eval run (repo empty seed + default graders) |
| `list_harnesses` | `harnesses:read` (viewer+) | workspace-owned + `_shared` |
| `validate_harness` | `harnesses:register` (admin) | dry-run: schema + this workspace's existing versions/conflict (no write) |
| `register_harness` | `harnesses:register` (admin) | register a `HarnessSpec` (immutable → `CONFLICT`) |

Authorization/validation failures come back as MCP tool errors (`isError`), e.g. `FORBIDDEN: …`.

## Auth — "login like Linear MCP" (MCP Authorization spec)
The MCP server is an OAuth **Protected Resource**; **Keycloak is the authorization server** (the same one the
web uses). The flow an MCP client (e.g. Claude Code) runs:

1. Calls `POST /mcp` with no token → **`401`** + `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
2. Fetches **`GET /.well-known/oauth-protected-resource`** (RFC 9728) → `{ resource: "<base>/mcp", authorization_servers: ["<KEYCLOAK_ISSUER>"], … }`.
3. Discovers Keycloak's metadata, does **OAuth 2.1 Authorization Code + PKCE** (browser login), gets an access token.
4. Retries `/mcp` with `Authorization: Bearer <jwt>`.

The control plane validates that Bearer with the **same auth core** as the HTTP API
(`compositeAuthenticator` → `oidcAuthenticator` verifies the Keycloak JWT via JWKS, or `apiKeyAuthenticator`
for `ak_…`) → a `Principal{workspace, roles}`. So MCP reuses everything: workspace = tenant = trust-zone, the
role→action matrix, JWKS verification. No second auth path.

Two credential kinds work on `/mcp`:
- **Keycloak OIDC** (interactive clients that log in) — the "login like Linear" path.
- **API key `ak_…`** (headless agents / CI) — `Authorization: Bearer ak_…`, no browser.

## Keycloak client
`deploy/keycloak/realm-assay.json` ships a public PKCE client **`assay-mcp`** (standard flow + loopback redirect
URIs + `pkce.code.challenge.method=S256` + the `workspace` claim mapper) for MCP clients that use a fixed
`client_id`. Clients that self-register can use Keycloak's **Dynamic Client Registration**
(`{issuer}/clients-registrations/openid-connect`) — enable anonymous DCR (or pre-register) per your realm policy.
`apps/api` advertises the authorization server only when `KEYCLOAK_ISSUER` is set; without it, MCP still works
with API keys.

## Run / connect
```bash
KEYCLOAK_ISSUER=http://localhost:8081/realms/assay ASSAY_REQUIRE_AUTH=1 node apps/api/dist/main.js
# MCP endpoint: http://localhost:8787/mcp  (an MCP client discovers Keycloak and prompts login)
```

## Verified
- **Deterministic** (`apps/api/src/mcp.test.ts`, in-memory MCP client↔server): `tools/list`; role gating
  (viewer read-only, member submits, admin registers); workspace scoping (another workspace's run → `NOT_FOUND`).
- **HTTP auth** (`server.test.ts`): unauthenticated `/mcp` → `401` + `WWW-Authenticate`; protected-resource
  metadata points at Keycloak.
- **Live** (`scripts/live/mcp-auth.mjs`, real Keycloak): discovery + `401` challenge; a real Keycloak OIDC token
  drives a stateful MCP session — `alice`(member) lists/submits but `register_harness` → `FORBIDDEN`;
  `carol`(admin) registers; an `ak_…` API key also authenticates `/mcp`.
