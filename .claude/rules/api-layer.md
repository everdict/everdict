---
paths: "apps/api/**"
---
# API layer rules (push) — the resource-slice idiom

`apps/api` follows a TS reinterpretation of the proven layered-service idiom (controller → service →
repository, domain-packaged, one-way call chain). See skill `api-layer` for the recipe;
`docs/architecture/api-route-modularization.md` is the design SSOT.

- **Two axes: root = layer, inside = domain.** `src/` has the layer roots — `api/` (transport) over `core/`
  (business logic), with `common/` (cross-cutting helpers) and `infrastructure/` (external-client plumbing)
  beneath both. **One-way: `common ← core ← api`** (api calls core; core never knows api; infrastructure
  imports only common). Inside each layer, one folder per **domain entity**, the SAME name recurring across
  layers (`api/run` + `core/run`, `api/scorecard` + `core/scorecard`, …): `api/<domain>/` holds
  `<resource>.routes.ts` (HTTP registration) + `<resource>.mcp.ts` (the same resource's MCP tools) +
  `request/<dto>.ts` (one file per request Zod DTO — only when the resource has bodies; registry-backed
  resources validate with the core spec schema directly, no file) + `response/<dto>.ts` (response DTO
  schemas — REUSE the `@everdict/db`/`@everdict/core` record/spec Zod schemas as the SSOT, define only
  what has no schema yet) + `<resource>.docs.ts` (the OpenAPI route descriptors) + inject-based transport
  tests; `core/<domain>/` holds `<resource>-service.ts` + collaborator services + service tests. A **sub-resource lives in its owner's domain** (harness-template in `harness/`, invite in
  `member/`). **NEVER a concern umbrella** (`catalog/`, `integrations/`) on the domain axis. Engine machinery
  lives in `core/execution/` and `core/ops/`; their thin transport surfaces in `api/execution/` + `api/ops/`.
  The **storage layer is not in apps/api** — it is the `@everdict/db` + `@everdict/registry` packages (the
  monorepo implements the module DAG at package level); services receive stores by injection.
- **One-way call chain — transport → service → store/registry.** Same direction always; a lower layer never
  learns about an upper one. A transport handler may call a store **directly only for envelope-free trivial
  CRUD** (secrets list/set/remove); the first composition, policy, or cross-store read promotes a service.
  **Peer resource services never call each other** — cross-resource data goes through the owning store/registry.
  The only sanctioned service→service edges are the named concern seams (orchestration services →
  `ScoringService` / `executeCase`; see `docs/architecture/execution-scoring-orchestration.md`). Adding a new
  service-to-service edge requires updating that doc — if you can't justify the seam in writing, inject the
  store instead.
- **A compound resource decomposes into sub-service collaborators behind a facade.** When one service accretes
  distinct lifecycles (batch orchestration vs ingest vs analytics), split them into named collaborator services
  in the same domain folder, composed by the facade — the facade keeps the external surface (`deps.<x>`, both
  transports, tests) stable. A service pushing ~500 lines of mixed lifecycles is the smell.
- **No hypothetical surface.** A field, parameter, or endpoint exists only if it has a **current caller**;
  "could be useful later" is removal grounds, not justification.
- **Routes are thin — the fixed handler shape, zero business logic:** ① feature-gate
  (`if (!deps.xService) → 404 "not configured"`) → ② authenticate (`resolvePrincipal`, return on undefined) →
  ③ authorize (`gate(principal, action)`, 403 via `sendError`) → ④ validate (`Schema.safeParse` → 400) →
  ⑤ delegate to the service with a command object (`{ tenant: principal.workspace, createdBy: principal.subject,
  ...body }`) → ⑥ map failures via `sendError`. Anything conditional beyond this shape belongs in the service.
  Services never touch HTTP (no req/reply, no status codes). Response shaping (domain → response mapping) is the
  service's job — a route returns the service result verbatim.
- **Shared context lives in `api/route-context.ts`** — `ServerDeps` + the auth chain (`resolveIdentity` /
  `applyActiveWorkspace` / `resolvePrincipal` / `resolveBearerPrincipal`) + `gate` / `sendError` / `zodIssues` /
  `constantTimeEq`. Route modules import from it; NEVER re-implement auth in a route (active-workspace logic has
  exactly one owner: `applyActiveWorkspace`).
- **Composition roots stay thin — one per surface.** `server.ts` (HTTP): app construction (parsers, logging,
  body limit), protocol-level wiring (WS upgrade, MCP transport/session state), and the
  `register<X>Routes(app, deps)` calls — no route bodies. `mcp.ts` (tools): the McpServer + shared helpers +
  `register<X>Tools(server, ctx)` calls — no tool bodies. `main.ts` (process): env → deps wiring grouped into
  per-concern builder functions — no business logic.
- Responses are **flat** — no success envelope. Error envelope is flat `{ code, message, data? }` from
  `AppError.toEnvelope()` (routes funnel every failure through `sendError`).
- **OpenAPI docs are separated from the implementation**: each resource's route descriptors (`summary` /
  `tags` / `params` / `body` / `response`, built from the `request/`+`response/` schemas via zod→JSON Schema)
  live in `<resource>.docs.ts`; `.routes.ts` only attaches `{ schema: docs.x }`. Served at `/docs`
  (`@fastify/swagger` + UI). **Doc-only**: the validator/serializer compilers are no-ops — request validation
  stays in the handler (safeParse → flat envelope) and responses serialize as plain JSON; attaching a schema
  must never change behavior. All OpenAPI text is English (repo language policy).
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
- **BFF↔MCP parity is structural**: a new capability = one service core + two transports, and **both live in
  the resource slice** (`<resource>.routes.ts` + `<resource>.mcp.ts`), never a fork — both call the same
  service function. Datasets/judges/scorecards mirror this; see rule `mcp` + `docs/datasets.md` +
  `docs/judges.md` + `docs/scorecards.md`.
- **Route-move gotchas**: route paths may sit on their **own line** (`app.get<…>(\n  "/x/:id/diff",` — a
  single-line grep misses them); check an exported schema's consumers before moving it; the `buildServer`+`inject`
  test suite is the safety net — the route surface must stay identical through a refactor.
