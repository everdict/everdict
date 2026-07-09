---
name: api-layer
description: The control-plane HTTP API (apps/api, Fastify) — domain-foldered resource slices (routes/schema/service), thin handlers over route-context, flat error envelopes, BFF↔MCP parity. Use when adding or editing API routes/services/schemas.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# API layer (`apps/api`)

The external SaaS surface. A Fastify server over the runtime (Scheduler + trust zones + secrets + budgets +
autoscaling). Structured by a TS reinterpretation of the proven layered-service idiom (controller → service →
repository, domain-packaged, one-way call chain): **one folder per domain entity; inside it, the entity's
vertical slice — routes + mcp + schema + service.** See `docs/api.md` +
`docs/architecture/api-route-modularization.md`. Rule: `.claude/rules/api-layer.md`.

## Structure map

```
apps/api/src/
  server.ts          ← HTTP composition root ONLY: app build (parsers/logging), WS upgrade, MCP transport,
                       register<X>Routes(app, deps) calls
  mcp.ts             ← MCP composition root ONLY: McpServer build + register<X>Tools(server, ctx) calls
                       (same services, second transport; helpers live in mcp-context.ts)
  main.ts            ← process composition root: env → deps wiring, grouped into per-concern builders
  route-context.ts   ← ServerDeps (deps bag) + auth chain (resolveIdentity/applyActiveWorkspace/
                       resolvePrincipal/resolveBearerPrincipal) + gate/sendError/zodIssues/constantTimeEq
  mcp-context.ts     ← McpDeps + McpToolContext + ok/fail/run/plain (the MCP twin of route-context)
  <domain>/          ← ONE business entity: run · scorecard · harness · dataset · judge · model · runtime ·
                       benchmark · bundle · schedule · view · secret · member · workspace · profile ·
                       notification · comment · api-key · runner · github-app · mattermost · trace-sink ·
                       image-registry · ci-link · queue · billing …
    <resource>.routes.ts    ← registerXRoutes(app, deps): thin handlers, zero logic
    <resource>.mcp.ts       ← registerXTools(server, ctx): the same resource's MCP tools, zero logic
    <resource>.schema.ts    ← request Zod DTOs (XxxBodySchema) — only when the resource has bodies
    <resource>-service.ts   ← the logic (framework-agnostic; owns response shaping + creator-override)
  execution/ ops/ lib/ oauth/  ← machinery, NOT transport domains (case-execution engine · instrumentation/
                       recovery · shared helpers · oauth plumbing)
```

- **Folder = entity, slice = the entity's vertical cut.** The folder is the business entity the URL prefix
  and registries name; a sub-resource lives in its owner's folder (harness-template in `harness/`, invite in
  `member/`, workspace-runner in `runner/`). Never an umbrella concern folder (`catalog/` grouping dataset +
  judge + model was the anti-pattern); never one mega-file per domain; never routes in server.ts; never tool
  bodies in mcp.ts. The slice owns **both transports** — parity is structural, not a convention you remember.

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

## Recipe: adding a resource
1. `<domain>/<resource>-service.ts` — logic + store access + response shaping. Inputs are command objects.
2. `<domain>/<resource>.schema.ts` — `CreateXBodySchema`/`UpdateXBodySchema` (Zod). Registry-backed resources
   often validate with the core spec schema directly (no schema file needed).
3. `<domain>/<resource>.routes.ts` — `registerXRoutes(app, deps)` in the fixed shape above.
4. `server.ts` — one `registerXRoutes(app, deps)` line. `route-context.ts` — add the service to `ServerDeps`
   (optional field; absent = feature-gated 404).
5. **MCP parity** — `<domain>/<resource>.mcp.ts` with `registerXTools(server, ctx)` calling the same service
   function; one `registerXTools(...)` line in `mcp.ts`. Descriptions carry the semantics (the tool schema IS
   the doc for agents).
6. Tests: `buildServer` + `inject` (see skill `testing`) — cover authz (401/403), validation (400), 404 scoping.

## Run lifecycle (`RunService`) — the archetype service
`submit`: `budget.admit(tenant)` (over-limit → 402, no run created) → `store.create(queued)` → return 202 →
(background) `executeCase` → on success `budget.settle(costOf)` + `store.update(succeeded, result)`,
on error `store.update(failed, envelope)` → optional `webhookUrl` POST of the final record. The dispatcher is a
`Dispatcher` — an in-process `Scheduler` (default) or the Temporal orchestrator for the durable path.

## Three concerns: execution · orchestration · scoring (don't re-tangle)
See `docs/architecture/execution-scoring-orchestration.md`.
- **Execution** = `execution/execute-case.ts` `executeCase(deps, owner, job) → CaseResult` — **pure**. No
  settle/offload/notify. `RunService` and `ScorecardService` both call it (never route the batch through
  `RunService.submit`).
- **Scoring** = `execution/scoring-service.ts` — judge application over results, independent of how they were
  produced (live batch **and** ingest share it); aggregation stays pure in `@everdict/suite`.
- **Orchestration** = the services drive execution and own admit/settle, delivery (202/webhook), notify, progress.

## Result store (`@everdict/db`)
`RunStore`/`ScorecardStore` (create/update/get/list). Default `InMemory*`; with `DATABASE_URL` the API uses the
`Pg*` stores and runs idempotent SQL migrations at boot. The store + migrator share an injectable `SqlClient`
(fake in tests, `pg.Pool` in prod). Migrations: `packages/db/migrations/` + `docs/migration/`.

## Gotchas
- Route paths can sit on their **own line** (`app.get<…>(\n  "/x/:id/diff",`) — grep `^\s+"/<resource>` too.
- Before moving an exported schema, grep its consumers (`mcp.ts`, tests) — update imports in the same change.
- The `server.test.ts` suite (buildServer+inject, ~636 tests incl. 401/403/400/404) is the refactor safety net:
  the route surface must stay identical.
- Body-less DELETE with `content-type: application/json` is tolerated (the lenient parser in server.ts) — don't
  add a second content-type parser.
