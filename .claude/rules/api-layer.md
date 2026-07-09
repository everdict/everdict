---
paths: "apps/api/**"
---
# API layer rules (push) — the resource-slice idiom

`apps/api` follows a TS reinterpretation of the proven layered-service idiom (controller → service →
repository, domain-packaged). See skill `api-layer` for the recipe;
`docs/architecture/api-route-modularization.md` is the design SSOT.

- **Domain folder = grouping; resource = slice.** `src/<domain>/` holds several *resource* slices, one per HTTP
  resource (a domain is NOT one file): `<resource>.routes.ts` (registration) + `<resource>.schema.ts` (request
  Zod DTOs + OpenAPI text, English — only when the resource has bodies) + `<resource>-service.ts` (logic).
  When a domain accretes resources, promote a **sub-domain folder** (e.g. `integrations/`).
- **Routes are thin — the fixed handler shape, zero business logic:** ① feature-gate
  (`if (!deps.xService) → 404 "not configured"`) → ② authenticate (`resolvePrincipal`, return on undefined) →
  ③ authorize (`gate(principal, action)`, 403 via `sendError`) → ④ validate (`Schema.safeParse` → 400) →
  ⑤ delegate to the service with a command object (`{ tenant: principal.workspace, createdBy: principal.subject,
  ...body }`) → ⑥ map failures via `sendError`. Anything conditional beyond this shape belongs in the service.
  Services never touch HTTP (no req/reply, no status codes). Response shaping (domain → response mapping) is the
  service's job — a route returns the service result verbatim.
- **Shared context lives in `route-context.ts`** — `ServerDeps` + the auth chain (`resolveIdentity` /
  `applyActiveWorkspace` / `resolvePrincipal` / `resolveBearerPrincipal`) + `gate` / `sendError` / `zodIssues` /
  `constantTimeEq`. Route modules import from it; NEVER re-implement auth in a route (active-workspace logic has
  exactly one owner: `applyActiveWorkspace`).
- **`server.ts` is a composition root only**: app construction (parsers, logging, body limit), protocol-level
  wiring (WS upgrade, MCP transport/session state), and the `register<X>Routes(app, deps)` calls. No route bodies.
- Responses are **flat** — no success envelope. Error envelope is flat `{ code, message, data? }` from
  `AppError.toEnvelope()` (routes funnel every failure through `sendError`).
- POST default status = **200** (201 allowed, but be consistent within a resource). No `/api` prefix.
- List endpoints are paginated by default (cursor: `created_at DESC, id DESC`, fetch `size+1`, opaque base64 token). No `pagination` wrapper.
- `/internal/**` routes are guarded by `x-internal-token` (constant-time compare, fail-closed if unset); no
  end-user auth context. `POST /internal/tenant-keys` issues API keys.
- Identity comes from the **auth core** (`@everdict/auth`): `Authorization: Bearer <jwt|ak_…>` →
  `Principal{subject,workspace,roles,via}` (OIDC/Keycloak + API key, composed). With `requireAuth` a
  missing/invalid credential is 401, else dev falls back to `x-everdict-tenant` (admin). Gate mutating routes with
  `gate(principal, action)` (403 on deny); EVERY read/write is **workspace-scoped** (runs + harnesses +
  datasets + judges + scorecards) — never trust a client-supplied tenant when auth is on; another workspace's
  resource reads 404, not 403. Creator-override ("admin or the creator") lives in the **service**, never in the
  route or the role matrix. See `docs/auth.md` + rule `auth`.
- **BFF↔MCP parity**: a new capability = one service core + two transports (an HTTP route module + an MCP tool
  in `mcp.ts`), never a fork — both call the same service function. Datasets/judges/scorecards mirror this; see
  rule `mcp` + `docs/datasets.md` + `docs/judges.md` + `docs/scorecards.md`.
- **Route-move gotchas**: route paths may sit on their **own line** (`app.get<…>(\n  "/x/:id/diff",` — a
  single-line grep misses them); check an exported schema's consumers before moving it; the `buildServer`+`inject`
  test suite is the safety net — the route surface must stay identical through a refactor.
