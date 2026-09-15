---
name: api-layer
description: The control-plane HTTP API (apps/api, Fastify) — domain-foldered resource slices (routes/schema/service), thin handlers over route-context, flat error envelopes, BFF↔MCP parity. Use when adding or editing API routes/services/schemas.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# API layer (`apps/api`)

The external SaaS surface: a Fastify server that is transport and composition over the layer spine. The
business code it serves is NOT in this app — the re-architecture moved the services into
`@everdict/application-control` and the domain models into `@everdict/domain`, and `apps/api` keeps the transport
slices, the composition roots and the machinery bound to this process. See `docs/api.md` +
`docs/architecture/api-route-modularization.md`. Rule: `.claude/rules/api-layer.md`.

## Structure map

```
packages/domain/src/<domain>/               ← models (guard methods + transitions returning store patches; an illegal
                                              transition throws from the domain) + <x>-policy.ts. docs/architecture/rich-domain-core.md
packages/application-control/src/<domain>/  ← <resource>-service.ts (orchestration ONLY: idempotency, cross-domain
                                              composition, events — never a status literal) + collaborators + tests
packages/application-control/src/ports/     ← the store/registry ports those services take (impls: @everdict/db, @everdict/registry)
packages/application-control/src/execution/ ← execute-case.ts (executeCase) · scoring-service.ts (ScoringService)

apps/api/src/
  main.ts            ← process composition root: env → deps, over the builders in composition/
  composition/       ← per-concern wiring builders (persistence, dispatch, run, scorecard, services, authenticator, …)
  server.ts          ← HTTP composition root ONLY: app build (parsers/logging/swagger), WS upgrade,
                       register<X>Routes(app, deps) calls
  mcp.ts             ← MCP composition root ONLY: McpServer build + register<X>Tools(server, ctx) calls
  mcp.routes.ts      ← the /mcp Streamable HTTP transport + session map
  api/               ← TRANSPORT layer (one folder per domain entity — `ls apps/api/src/api`)
    route-context.ts   ← ServerDeps (deps bag) + auth chain (resolveIdentity/applyActiveWorkspace/
                         resolvePrincipal/resolveBearerPrincipal) + gate/sendError/zodIssues/constantTimeEq
    mcp-context.ts     ← McpDeps + McpToolContext + ok/fail/run/plain (the MCP twin of route-context)
    <domain>/          ← (execution/ + ops/ = the thin transport surfaces of the machinery below)
      <resource>.routes.ts   ← registerXRoutes(app, deps): thin handlers, zero logic
      <resource>.mcp.ts      ← registerXTools(server, ctx): the same resource's MCP tools, zero logic
      <resource>.docs.ts     ← OpenAPI route descriptors (summary/tags/params/body/response) — the
                               docs/impl separation; routes attach { schema: docs.x }
      request/<dto>.ts       ← one file per request Zod DTO (XxxBodySchema) — only when it has bodies
      response/<dto>.ts      ← response DTO schemas (reuse @everdict/contracts record/spec schemas as SSOT)
      (+ inject-based transport tests)
  core/              ← app-bound machinery that did not move to a package (~35 files)
    execution/         ← dispatchers (runtime/seeding/judge-auth/…), self-hosted + topology backends, judge-runner
    ops/               ← runtime inspect/probe/control, driver ops
    schedule/ · scorecard/  ← the Temporal drivers
    <domain>/          ← a few services bound to an adapter package (model, bundle, benchmark, browser-session, …)
  common/            ← cross-cutting helpers (budget-tracker, usage-meter, live stores, tickets, …)
  infrastructure/    ← external-client plumbing (github, mattermost, oauth, registry, browser-session, …)
```

- **Where a thing goes.** A new service → `packages/application-control/src/<domain>/`; a new model or policy →
  `packages/domain/src/<domain>/`; its transports → `apps/api/src/api/<domain>/`. `apps/api/src/core/` is only
  for code that needs an adapter package or this process. One-way imports inside the app:
  `common ← infrastructure ← core ← api`; only `main.ts` imports `composition/`.
  A sub-resource lives in its owner's domain (harness-template in `harness/`, invite in `member/`). Never a
  concern umbrella (`catalog/`) on the domain axis; never routes in server.ts; never tool bodies in mcp.ts.
  The slice owns **both transports** — parity is structural, not a convention you remember. Storage is the
  `@everdict/db`/`@everdict/registry` packages, injected — apps/api has no storage layer of its own.

## The MCP transport gets the WHOLE deps bag

`mcp.routes.ts` hands `buildMcpServer` `{ ...deps, apiPublicUrl }` — the ServerDeps spread, never a hand-copied
field list. It used to name each service individually, and a service added to the routes but forgotten there lost
its ENTIRE tool family with no error anywhere: the HTTP routes worked, `tools/list` was just quietly shorter (it
happened to capabilities, then to the whole knowledge family — 49 tools missing). Spreading turns `McpDeps` into a
compile-time contract. So a new service reaches MCP the moment it is on `ServerDeps`; the only thing a tool family
still needs is its `register<X>Tools(server, ctx)` line in `mcp.ts` and its own `if (!deps.xService) return` gate.

## Call chain — one direction, always

`transport (route | tool) → service → store/registry → DB`. A lower layer never knows an upper one.
- A transport handler may call a store **directly only for envelope-free trivial CRUD** (e.g. secrets
  list/set/remove). The first composition, policy decision, or cross-store read promotes a service.
- **Peer resource services never call each other.** Cross-resource data goes through the owning
  store/registry, not the sibling service — service graphs are how mega-monoliths grow back. The sanctioned
  exceptions are the named concern seams (orchestration → `ScoringService`/`executeCase`); a new seam must be
  argued in `docs/architecture/execution-scoring-orchestration.md`, not just wired.
- **Compound resources decompose behind a facade.** When one service accretes distinct lifecycles (batch
  orchestration vs ingest vs analytics), extract named collaborator services in the same domain folder and
  compose them in the facade — `deps.<x>`, both transports, and the tests stay untouched.

## The handler shape (fixed — anything more belongs in the service)

```ts
export function registerXRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/xs", async (req, reply) => {
    if (!deps.xService) return reply.code(404).send({ code: "NOT_FOUND", message: "x service not configured" }); // ① feature gate
    const principal = await resolvePrincipal(req, reply, deps);                                                  // ② authenticate
    if (!principal) return reply;
    try { gate(principal, "xs:write"); } catch (err) { return sendError(reply, err); }                           // ③ authorize
    const parsed = CreateXBodySchema.safeParse(req.body);                                                        // ④ validate
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {                                                                                                        // ⑤ delegate (command object)
      return reply.code(201).send(await deps.xService.create({ tenant: principal.workspace, createdBy: principal.subject, ...parsed.data }));
    } catch (err) { return sendError(reply, err); }                                                              // ⑥ map failures
  });
}
```

Gate **before** validate (don't leak validation info to the unauthorized). Read routes gate `xs:read`; another
workspace's resource is 404 (no existence leak). "Admin or creator" checks live in the service
(`deleteDatasetVersion` pattern), never in the route.

**A role gate is not an audience.** `runs:read` says a member may read this workspace's executions, not that
they may read each other's: an agent turn is a conversation and a sandbox session is somebody's shell, so
`runAudience`/`canReadRun` (`@everdict/domain`) keeps those for their owner — enforced in `RunService`
(both transports inherit it), in `runVisible` (route-context, for the routes that already hold the record) and
in the ledgers themselves (`RunListOptions.viewer`, `TrajectoryMeta.owner`), always as **404**. When a new
surface serves runs or their evidence, ask the audience question there too; see docs/api.md §Run audience.

## Recipe: adding a resource
1. `packages/application-control/src/<domain>/<resource>-service.ts` — logic + store access + response shaping,
   over a port in `ports/` (impl in `@everdict/db`/`@everdict/registry`); export it from the package index.
   Inputs are command objects. A lifecycle's legality goes in a `packages/domain/src/<domain>/` model.
2. `api/<domain>/request/<dto>.ts` — `CreateXBodySchema`/`UpdateXBodySchema` (Zod), one file per DTO.
   Registry-backed resources often validate with the contracts spec schema directly (no file needed).
3. `api/<domain>/<resource>.routes.ts` — `registerXRoutes(app, deps)` in the fixed shape above.
4. `server.ts` — one `registerXRoutes(app, deps)` line. `api/route-context.ts` — add the service to
   `ServerDeps` (optional field; absent = feature-gated 404), constructed in `main.ts` or its `composition/` builder.
5. **MCP parity** — `api/<domain>/<resource>.mcp.ts` with `registerXTools(server, ctx)` calling the same
   service function; one `registerXTools(...)` line in `mcp.ts`. Descriptions carry the semantics (the tool
   schema IS the doc for agents).
6. **OpenAPI** — `api/<domain>/response/<dto>.ts` (reuse the contracts record schema if one exists) +
   `api/<domain>/<resource>.docs.ts` descriptors; attach `{ schema: docs.x }` in the route registration.
   Doc-only (no-op validator/serializer) — never changes behavior; English text.
7. Tests: `buildServer` + `inject` (see skill `testing`) — cover authz (401/403), validation (400), 404 scoping.

## Run lifecycle (`RunService`, application-control) — the archetype service
`submit`: `admitCausedWork` (only when an agent caused the run) → `budget.admit(tenant)` (over-limit → 402, no run
created) → `Run.newQueued` + `store.create` → the route returns 202 → (background) `executeCase` →
`budget.settle` + the `Run` transition (`succeed`/`fail`), whose terminal fact `runWebhookConsumer` later turns into
the optional `webhookUrl` callback (never fired inline). The
dispatcher is a `Dispatcher` — an in-process `Scheduler` (default) or the Temporal orchestrator for the durable path.

## Three concerns: execution · orchestration · scoring (don't re-tangle)
See `docs/architecture/execution-scoring-orchestration.md`. Both files below are in
`packages/application-control/src/execution/`.
- **Execution** = `execute-case.ts` `executeCase(deps, owner, job, opts?) → CaseResult` — **pure**. No
  settle/offload/notify. `RunService` and `ScorecardService` both call it (never route the batch through
  `RunService.submit`).
- **Scoring** = `scoring-service.ts` `ScoringService` — judge application over results, independent of how they were
  produced (live batch **and** ingest share it); aggregation stays pure in `@everdict/domain`.
- **Orchestration** = the services drive execution and own admit/settle, delivery (202/webhook), notify, progress.

## Result store (`@everdict/db`)
`RunStore`/`ScorecardStore` (create/update/get/list). Default `InMemory*`; with `DATABASE_URL` the API uses the
`Pg*` stores and runs idempotent SQL migrations at boot. The store + migrator share an injectable `SqlClient`
(fake in tests, `pg.Pool` in prod). Migrations: `packages/db/migrations/` + `docs/migration/`.

## Gotchas
- Route paths can sit on their **own line** (`app.get<…>(\n  "/x/:id/diff",`) — grep `^\s+"/<resource>` too.
- Before moving an exported schema, grep its consumers (`mcp.ts`, tests) — update imports in the same change.
- The `server.test.ts` suite (buildServer+inject, incl. 401/403/400/404) is the refactor safety net:
  the route surface must stay identical.
- Body-less DELETE with `content-type: application/json` is tolerated (the lenient parser in server.ts) — don't
  add a second content-type parser.
