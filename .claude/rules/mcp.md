---
paths: "apps/api/src/mcp.ts,apps/api/src/mcp.test.ts"
---
# MCP server rules (push)

The agent-facing surface (`apps/api` `/mcp`, Streamable HTTP). Same service core as the HTTP routes, just a
second transport. See `docs/mcp.md` + rule `auth`.

- **Reuse the service core** (`RunService` + `HarnessRegistry`) — MCP tools are a transport over the SAME logic
  the HTTP routes use, not a fork. A new capability = one feature, two transports (HTTP route + MCP tool).
- **Tools live in the resource slice**: `<domain>/<resource>.mcp.ts` exports `registerXTools(server, ctx)` next
  to the resource's `.routes.ts`; `mcp.ts` is a composition root (McpServer build + shared `ok`/`fail`/`run`
  helpers + the register calls) with no tool bodies. See rule `api-layer`.
- **Same auth core, no second path.** The Bearer on `/mcp` is validated by the SAME `compositeAuthenticator`
  (Keycloak JWT via JWKS / `ak_…`) → `Principal`. Build the MCP server bound to that Principal; every tool gates
  with `authorize(principal, action)` and scopes to `principal.workspace`. Authz/validation failures → MCP tool
  error (`isError: true`, message prefixed with the AppError code), not a thrown protocol error.
- **OAuth = MCP Authorization spec ("login like Linear").** No token → `401` + `WWW-Authenticate:
  resource_metadata=…`; serve `/.well-known/oauth-protected-resource` (RFC 9728) naming **Keycloak** as the
  authorization server (`authorizationServers` from `KEYCLOAK_ISSUER`). Never invent a bespoke MCP login.
- **No dev fallback on `/mcp`** — it must `401` (not silently allow `x-everdict-tenant`) so the client starts the
  OAuth flow. (Dev fallback stays on the human/HTTP routes only.)
- **Stateful sessions**: create the MCP server + transport on `initialize`, store by `mcp-session-id`, route
  later POST/GET/DELETE to it, clean up on `onclose`. `reply.hijack()` before handing the raw stream to the
  transport. Pass the Fastify-parsed `req.body` to `handleRequest` (don't re-read the stream).
- **Test both layers**: tool logic via the in-memory MCP client↔server pair (role gating + workspace scoping);
  the `401`/metadata challenge via Fastify `inject`. Live OAuth is validated headless via ROPC (no browser).
