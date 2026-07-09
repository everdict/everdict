# apps/api route modularization — split the 3676-line server.ts into domain route modules (design)

> **Status: design locked; realizes the api-layer rule's own convention; executed in green-gated slices.** This is
> not a new architecture — the `api-layer` rule already mandates *"three-file split per resource: `*.routes.ts` +
> `*.schema.ts` + `*.service.ts`; routes never contain business logic."* The services are already domained
> (`2258302`: execution/catalog/workspace/…). This refactor finishes the job: the routes (and their request
> schemas), still inline in one mega-file, move next to their services. Public route surface is unchanged, so the
> 636 apps/api tests are the safety net at every step.

## Problem

`apps/api/src/server.ts` is **3676 lines**: 42 imports + **17 route request schemas** (SubmitBodySchema,
RunScorecardBodySchema, CreateScheduleBodySchema, … lines 97–240) + `ServerDeps` (45 fields) + the auth-resolution
helpers (lines 294–444) + **158 route registrations** across ~30 path prefixes, all in one `buildServer(deps)`. Every
route change touches the mega-file; nothing is owned by a domain; it contradicts the documented three-file split.

## Current state — verified (why this is tractable)

- **Auth helpers are already `deps`-parameterized module functions**, not closures over `buildServer` locals:
  `resolvePrincipal(req, reply, deps)` (`server.ts:383`, 140 call sites), `resolveIdentity`, `applyActiveWorkspace`,
  `resolveBearerPrincipal`, `zodIssues` (24), `constantTimeEq` (10), `mcpChallenge`, `protectedResourceMetadata`,
  `baseUrl`. So a route body only needs `deps` + these imported helpers — it extracts cleanly.
- **Only MCP has local state** inside `buildServer` (`sessions` map + `bySession`/`metaHandler` for
  `StreamableHTTPServerTransport`). Everything else is stateless wiring.
- **`noUnusedLocals` is unset** → moving code without perfectly-pruned imports doesn't fail `tsc`; `biome check
  --write` prunes/sorts. So the compiler-guided move (proven on the package restructures) applies here too.
- **The route paths don't change** → `buildServer(deps)` builds the same app; the 636 `buildServer`+`inject` tests
  pass unchanged at every slice. This is the invariant that makes the refactor safe.

## Design

```
apps/api/src/
  server.ts            — thin: create app + content-type parsers + WS + error handling, then call the
                         register*Routes(app, deps) of each domain. (MCP session state may stay here or in mcp.routes.ts.)
  route-context.ts     — ServerDeps (45-field deps bag) + the auth chain (resolveIdentity / workspaceHintOf /
                         applyActiveWorkspace / resolvePrincipal / resolveBearerPrincipal) + helpers (zodIssues /
                         constantTimeEq / baseUrl / protectedResourceMetadata / mcpChallenge). Shared by server + routes.
  <domain>/
    x-service.ts       — (exists) logic
    x.routes.ts        — registerXRoutes(app: FastifyInstance, deps: ServerDeps): void  — the route registrations
    x.schema.ts        — the route request Zod schemas that live in server.ts's head today
```

Routes co-locate with their service (the `<domain>/` folders already exist: `execution` runs/scorecards,
`catalog` harnesses/datasets/judges/models/runtimes/benchmarks/bundles, `workspace` workspace/members/secrets/…,
`integrations`, `runners`, `scheduling`, `ops`, `account`). `server.ts` shrinks to a composition root.

`ServerDeps` MUST move to `route-context.ts` (not stay in server.ts): route modules import it, and importing it from
server.ts would be a cycle (server imports the route modules). Keep `applyActiveWorkspace` the single owner of
active-workspace logic (auth rule) — routes call `resolvePrincipal`, never re-implement it.

## Extraction recipe (per resource — the proven package-restructure pattern)

1. `x.schema.ts` — move the resource's request schemas out of server.ts's head.
2. `x.routes.ts` — `export function registerXRoutes(app, deps) { app.post("/x", …); … }`; move the route blocks
   verbatim; add imports (start generous, `biome check --write` prunes, `tsc` names what's missing).
3. `server.ts` — delete those blocks; `registerXRoutes(app, deps)` inside `buildServer`.
4. Gate: `biome` (scoped) + `pnpm --filter @everdict/api typecheck` + **the 636 tests** + build. One commit per resource.

BFF↔MCP parity is preserved — the MCP tools (`mcp.ts`) already call the same services; only the HTTP registration moves.

## Slices (green-gated, one commit each)

1. **F — `route-context.ts`.** Move `ServerDeps` + auth helpers; server.ts imports them. No routes move yet. (The
   enabler; unblocks every domain.)
2. **Pilot — one clean resource** (e.g. `runs` → `execution/run.routes.ts` + `run.schema.ts`). Proves the recipe.
3. **Rollout by domain:** execution (runs, scorecards) · catalog (harnesses+templates, datasets, judges, models,
   runtimes, benchmarks+recipes, bundles) · account (/me, /keys, /notifications, /comments) · members (/members,
   /invites) · scheduling · ops (/queue, /metrics, /usage, /budget, /healthz, /frontdoor-callback) · internal.
4. **workspace/ (31 routes — the beast):** sub-split into `workspace/{settings,secrets}.routes.ts` +
   `integrations/{github-app,mattermost,image-registry,trace-sink,ci-link}.routes.ts` + `runners/runner.routes.ts`.
5. **mcp.routes.ts** — the `/mcp` routes + the `sessions`/`bySession` transport state.
6. **Thin server.ts** — down to app setup + the `register*Routes` calls; update the `api-layer` skill/rule to point
   routes at `*.routes.ts` (skills travel with the code).

## Risks

- **Security-critical (auth).** Keep the auth chain in `route-context.ts` intact and centralized; never inline
  `applyActiveWorkspace` into a route. Each slice keeps the 636 tests (which include auth 401/403 cases) green.
- **A big central file.** Strictly incremental — one resource per commit, route surface unchanged, tests green each
  time. Never a single mega-edit.
- **Coordinate with the shared tree.** apps/api is an active area; check `git status` before each slice and only
  stage the resource being moved.
