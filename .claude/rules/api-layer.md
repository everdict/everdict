---
paths: "apps/api/**"
---
# API layer rules (push) — the resource-slice idiom

`apps/api` follows a TS reinterpretation of the proven layered-service idiom (controller → service →
repository, domain-packaged, one-way call chain). See skill `api-layer` for the recipe;
`docs/architecture/api-route-modularization.md` is the design SSOT.

- **Folder = the domain entity; slice = that entity's vertical cut through both transports.** `src/<domain>/`
  is one folder per business entity directly under src — the thing the URL prefix and the registries name
  (run, scorecard, harness, dataset, judge, model, runtime, benchmark, bundle, schedule, view, secret, member,
  workspace, profile, notification, comment, api-key, runner, github-app, mattermost, trace-sink,
  image-registry, ci-link, queue, billing, …). Inside it live that entity's files: `<resource>.routes.ts`
  (HTTP registration) + `<resource>.mcp.ts` (the same resource's MCP tools) + `<resource>.schema.ts` (request
  Zod DTOs + OpenAPI text, English — only when the resource has bodies) + `<resource>-service.ts` (logic) +
  collaborator services + colocated tests. A **sub-resource lives in its owner's folder** (harness-template in
  `harness/`, invite in `member/`, workspace-runner in `runner/`). **NEVER an umbrella concern folder**
  (`catalog/`, `integrations/` as grouping buckets) — the folder axis is the entity, not the concern.
  Machinery that is not a transport domain keeps concern folders: `execution/` (the case-execution engine),
  `ops/` (instrumentation/recovery), `lib/`, `oauth/`.
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
- **Shared context lives in `route-context.ts`** — `ServerDeps` + the auth chain (`resolveIdentity` /
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
