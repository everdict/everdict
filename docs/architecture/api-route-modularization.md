# apps/api route modularization — split the 3676-line server.ts into resource route modules (design)

> **Status: Round 1 + Round 2 SHIPPED.** Round 2 (`b1c5d2a`…`4b53aba`): the MCP tool surface split into
> **31 per-resource `<resource>.mcp.ts` modules** (129 tools verbatim; `mcp.ts` 2,564 → **88-line composition
> root** over `mcp-context.ts`), `ScorecardService` decomposed into **facade (465) + batch (1,264) + ingest
> (223) + analytics (113) + shared (284)** with the public surface re-exported unchanged, and `main()` grouped
> into **8 per-concern builders** (753 → 386 lines; order-sensitive blocks and the scheduleService late-bind
> closure deliberately left inline). Every slice landed with the 636-test suite green; the final state also
> passes build + the empty-env boot contract. Round 1: all 158 routes extracted into **34 resource
> route modules** (+9 schema files) across `execution/ catalog/ workspace/ integrations/ runners/ scheduling/
> ops/` + `mcp.routes.ts` (`3929563`…`07ed7e1`); `server.ts` is a **285-line composition root** (was 3676):
> app construction, the domain-grouped register-call list, and the WS terminal upgrade. Every slice landed
> with the full 636-test suite green; final state also passes apps/api build + the full workspace typecheck
> (42/42). This realizes the `api-layer` rule's own convention — *"three-file split per resource"* — the
> services were already domained (`2258302`); the routes now live next to them. Round 2 (below) extends the
> same idiom to the remaining monoliths: the MCP tool surface, the compound `ScorecardService`, and the
> `main.ts` wiring.
>
> **Slicing refinement (locked):** the slice unit is the **resource, not the domain**. A domain folder groups
> several resource modules (`catalog/` = dataset + judge + model + runtime + benchmark + bundle + harness …);
> a large domain promotes **sub-domain folders** (`integrations/` beside `workspace/`). This follows the proven
> layered-service idiom (thin controller → service → repository, domain-packaged, request-DTO files per
> resource) reinterpreted for Fastify/TS — codified in `.claude/rules/api-layer.md` + skill `api-layer`.

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

## Round 2 — the layered-service ideology, applied to what's left

Round 1 fixed the HTTP transport. Three monoliths still contradict the idiom the harness codifies
(one-way call chain `transport → service → store`; peer services never call each other — the sanctioned seams
are documented in `execution-scoring-orchestration.md`; the resource slice owns **both** transports; a field
without a current caller does not exist):

### R2-a — MCP tool surface → per-resource tool modules

`mcp.ts` is 2,564 lines: 129 `registerTool` bodies inside one `buildMcpServer`. The HTTP surface got resource
modules; the second transport didn't — parity is currently a convention, not a structure. Split:

```
<domain>/<resource>.mcp.ts   ← export function registerXTools(server: McpServer, ctx: McpToolContext): void
mcp.ts                       ← composition root: McpServer build + shared helpers (ok/fail/run, session state
                               stays with the transport in server.ts/mcp.routes.ts) + registerXTools calls
```

`McpToolContext` = `{ deps, principal, ws }` (as shipped); the `ok`/`fail`/`run`/`plain` helpers are imported
from `mcp-context.ts` directly. Tool names, descriptions, schemas, and behavior move **verbatim**;
`mcp.test.ts` (the in-memory client↔server suite) is the safety net — the tool surface must stay identical.
Shipped as two commits: the mcp-context extraction, then the 31-module split (the per-domain extraction ran as
parallel file-creation, so a single gated switch-over of the composition root was the honest commit unit).

### R2-b — `ScorecardService` (2,122 lines) → facade + lifecycle collaborators

One class mixes four lifecycles: batch orchestration (submit/plan/runBatchCase/finalize + batchContexts),
ingest (push `ingest` / pull `ingestPull` + track/finish/fail), analytics reads (diff/trend/leaderboard/
backfillModels), and progress/export tracking (`track`, offload, export). Decompose into collaborator services
in `execution/`, composed by the facade so `deps.scorecards`, both transports, and every existing test stay
untouched:

```
scorecard-service.ts            ← the facade: submit/get/list + composition; public surface UNCHANGED
scorecard-batch-service.ts      ← batch contexts + plan/run/finalize/retry/resume (Temporal bridge included)
scorecard-ingest-service.ts     ← push + pull ingest lifecycles
scorecard-analytics-service.ts  ← diff / trend / leaderboard / backfillModels (reads over the store + suite)
```

Collaborators receive the stores/seams they need (never each other); the facade is the only composer. The
`ScoringService` edge stays — it is the documented scoring seam.

### R2-c — `main.ts` wiring → per-concern builders

`main()` is ~785 lines of env→deps wiring in one function. Group it into named builder functions inside
`main.ts` (persistence, auth, registries, execution, integrations, observability, server assembly) — the
process composition root reads as a table of contents; no behavior change. (A `main/` folder is overkill until
builders grow past ~15 — same flat-until-grouped rule as packages.)

Shipped: `buildExecutionScheduling` · `buildObservability` · `startAutoscaler` · `buildBudgets` ·
`buildDispatch` · `buildIntegrations` · `buildRuntimeAccess` · `runStartupRecovery`. Deliberately inline: the
persistence+workspace-services+seeding block (owns the `scheduleService` late-bind closure), the
`RunService`/`ScorecardService` constructions (single constructors over 15-24 bindings — a builder would only
thread spaghetti), and the `buildServer` assembly. The empty-env boot contract
(`scripts/live/empty-env-boot.mjs`) is main.ts's behavior gate.

Gates per slice: scoped Biome + `pnpm --filter @everdict/api typecheck` + the full apps/api test suite + build.
