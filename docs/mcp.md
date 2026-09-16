---
kind: wiki
title: "MCP server (agent-facing, OAuth-protected)"
status: current
updated: 2026-09-15
anchors: [apps/api/src/mcp.routes.ts, deploy/keycloak/enable-mcp-dcr.sh]
---

> Same subject, other audience: [the product page](guide/integrations/mcp.md) is what a user reads. This page is the design SSOT — state the mechanism here and link, never restate.
# MCP server (agent-facing, OAuth-protected)

The platform's **agent-facing surface**: an MCP server inside `apps/api` that exposes the same operations as the
HTTP API as MCP tools, **authenticated like Linear's MCP** — the client logs in via OAuth and the control plane
validates the token. Humans use the web; agents (Claude Code, Codex, CI, `apps/agent`) use MCP.

## The tool catalog is self-describing — this page does not list it

Every tool's name, description and input schema is what `tools/list` returns; the source is the owning resource
slice, `apps/api/src/api/<domain>/<resource>.mcp.ts`, next to the `<resource>.routes.ts` it mirrors.
`apps/api/src/mcp.ts` is only the composition root (`buildMcpServer` registers each slice's tools per Principal).
What the catalog cannot tell you:

- **Parity is structural.** A tool and its HTTP route call the same service function, gate the same action with
  `authorize(principal, action)`, and scope to `principal.workspace` — another workspace's resource is
  `NOT_FOUND`, as over HTTP. The per-action role matrix is in [auth.md](auth.md).
- **Errors are tool errors** (`isError`), rendered as `CODE: message` — e.g. `FORBIDDEN: …`. When the `AppError`
  carries structured data it is appended as JSON under that line, the same payload the HTTP envelope puts in
  `data` (`failFrom`, `apps/api/src/api/mcp-context.ts`). That is how a caller recovers rather than just failing:
  `write_file` losing a race to a concurrent publish returns `CONFLICT: …` plus the live content and an attempted
  three-way merge.
- **A campaign evidence grant** (`Bearer cpe_…`) gets a server with only the campaign evidence tools.

## Endpoint and sessions
Streamable-HTTP MCP at **`POST /mcp`** (`GET /mcp` = the SSE stream, `DELETE /mcp` = end session), stateful
sessions keyed by `mcp-session-id` (`apps/api/src/mcp.routes.ts`):

- A new session starts only with an `initialize` request; any other session-less request is `400`. An unknown
  session id (e.g. after a control-plane restart) is `404`, which per the spec tells the client to re-initialize.
- A session is bound to the authority that opened it (subject, workspace, via, roles, scopes, runner id): the
  same session id presented by a different credential is `403`.
- Idle sessions are evicted after `EVERDICT_MCP_SESSION_IDLE_MS` (default 10 min) — a SIGKILLed client never sends
  `DELETE`, and each session holds a whole server.
- There is **no dev fallback** on `/mcp`: the `x-everdict-tenant` header does not authenticate; no Bearer is a
  `401` challenge.

## Auth — "login like Linear MCP" (MCP Authorization spec)
The MCP server is an OAuth **Protected Resource**; **Keycloak is the authorization server** (the same one the
web uses). The flow an MCP client runs:

1. Calls `POST /mcp` with no token → **`401`** + `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
2. Fetches **`GET /.well-known/oauth-protected-resource`** (RFC 9728; also served at `…/oauth-protected-resource/mcp`)
   → `{ resource: "<base>/mcp", authorization_servers: ["<KEYCLOAK_ISSUER>"], bearer_methods_supported, scopes_supported, resource_name }`.
3. Discovers Keycloak's metadata, does **OAuth 2.1 Authorization Code + PKCE** (browser login), gets an access token.
4. Retries `/mcp` with `Authorization: Bearer <jwt>`.

The control plane validates that Bearer with the **same composed authenticator** as the HTTP API → a
`Principal`, then applies the same active-workspace resolution. No second auth path. Credentials that work on
`/mcp`: a Keycloak OIDC token (interactive clients), a personal API key `ak_…` (headless agents / CI, no
browser), an agent execution token `agt_…` (`apps/agent`), and a runner pairing token `rnr_…` (self-hosted
runners — the runner lease tools accept only this credential, and it carries no role-matrix action).

## Keycloak client
`deploy/keycloak/realm-everdict.json` ships a public PKCE client **`everdict-mcp`** (standard flow + loopback
redirect URIs + `pkce.code.challenge.method=S256` + the `workspace` claim mapper) for MCP clients that use a fixed
`client_id`. `apps/api` advertises an authorization server only when `KEYCLOAK_ISSUER` is set; without it,
`authorization_servers` is empty and MCP works with API keys only.

Clients that self-register need **anonymous Dynamic Client Registration** (RFC 7591): the client registers a
loopback-redirect client, then does Authorization Code + PKCE. Keycloak's default **Trusted Hosts** anonymous
policy blocks this (`403`); `deploy/keycloak/enable-mcp-dcr.sh` relaxes it once to trust loopback redirect URIs
only (`localhost`/`127.0.0.1`, client-URI validation kept on). The realm export carries no default policy
components, so run the script after the realm exists. API keys never need DCR.

## Run / connect
```bash
KEYCLOAK_ISSUER=http://localhost:8081/realms/everdict EVERDICT_REQUIRE_AUTH=1 pnpm api
# MCP endpoint: http://localhost:8787/mcp  (an MCP client discovers Keycloak and prompts login)
```
Client setup is product documentation: [Claude Code plugin](guide/integrations/claude-code-plugin.md) and
[Codex](guide/integrations/codex.md).

## Verified
- **Deterministic** (`apps/api/src/mcp.test.ts`, in-memory MCP client↔server): `tools/list`; role gating (viewer
  reads and registers harness templates/instances — ungated collaborative content; viewer `submit_run` is a
  permission error; member submits runs and creates datasets; admin-only governance tools refuse a member);
  workspace scoping (another workspace's run → `NOT_FOUND`); runner-only tools refuse regular credentials.
- **HTTP auth** (`apps/api/src/server.test.ts`): unauthenticated `POST /mcp` → `401` + `WWW-Authenticate`
  carrying `resource_metadata`; the protected-resource metadata names the `/mcp` resource; authenticated but
  session-less `GET /mcp` → `400`.
- **Live** (`scripts/live/mcp-auth.mjs`, `scripts/live/mcp-oauth.mjs`, real Keycloak): discovery + `401`
  challenge, a Keycloak OIDC token driving a stateful session, an `ak_…` key on `/mcp`, and the full browser flow
  (anonymous DCR → Authorization Code + PKCE → login → consent → loopback `?code` → token exchange → `initialize`
  + `tools/list`). `mcp-auth.mjs` matches the current matrix: a member's `register_harness` is refused for the
  SPEC, never as `FORBIDDEN` (`harnesses:register` is viewer+), and an admin's registration must name what it
  registered. Its `tools/list` assertion names the tools the script drives rather than counting them — a count
  said nothing about which tools a role got, and drifted with every unrelated tool the API added.
