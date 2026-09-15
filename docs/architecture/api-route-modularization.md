---
kind: wiki
title: "apps/api route modularization — split the 3676-line server.ts into resource route modules (design)"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/route-context.ts, apps/api/src/api/mcp-context.ts, apps/api/src/mcp.routes.ts]
---
# apps/api route modularization — split the 3676-line server.ts into resource route modules (design)

> **Shipped in five rounds (2026-07), then absorbed by the re-architecture.** This page records why
> `apps/api` is shaped the way it is. The recipe for adding a route is skill `api-layer`; where business code
> lives after the re-architecture is skill `foundation`
> (`.claude/skills/foundation/references/architecture.md`).

## Problem — what it replaced

`apps/api/src/server.ts` was **3676 lines**: 17 request schemas, a 45-field `ServerDeps`, the auth-resolution
helpers, and **158 route registrations** across ~30 path prefixes, all inside one `buildServer(deps)`. Every route
change touched the mega-file, nothing was owned by a domain, and it contradicted the documented per-resource split.
`mcp.ts` had the same shape (129 tool bodies in one function, 2,564 lines), `ScorecardService` was 2,122 lines
mixing four lifecycles, and `main()` was ~785 lines of wiring in one function.

What made it tractable: the auth helpers were already `deps`-parameterized module functions rather than closures
over `buildServer` locals, only MCP held local state, and the route paths never changed — so `buildServer(deps)`
built the same app at every step and the `buildServer`+`inject` suite stayed the safety net.

## The shape that exists

```
apps/api/src/
  server.ts          ← HTTP composition root: app construction, content-type parsers, @fastify/swagger,
                       one child scope of register<X>Routes(app, deps) calls, the terminal WebSocket upgrade
  mcp.ts             ← MCP composition root: McpServer build + register<X>Tools(server, ctx) calls
  mcp.routes.ts      ← the /mcp HTTP routes + the Streamable HTTP session map
  main.ts            ← process composition root, over builders in composition/
  composition/       ← per-concern wiring builders (persistence, dispatch, integrations, runtime access, …)
  api/               ← transport layer, one folder per domain entity
    route-context.ts   ← ServerDeps + the auth chain (resolveIdentity / applyActiveWorkspace /
                         resolvePrincipal / resolveBearerPrincipal) + gate / sendError / zodIssues / constantTimeEq
    mcp-context.ts     ← the MCP twin: McpToolContext + ok / fail / run
    <domain>/          ← <resource>.routes.ts · <resource>.mcp.ts · <resource>.docs.ts · request/ · response/
  core/              ← app-bound machinery that did not move to a package (dispatchers, backends,
                       judge runner, Temporal drivers, a few adapter-bound services)
  common/            ← cross-cutting helpers (budget-tracker, usage-meter, …)
  infrastructure/    ← external-client plumbing (GitHub, Mattermost, OAuth, registries)
```

The business services and domain models the rounds below grouped under `core/<domain>/` were moved by the
re-architecture into `packages/application-control` (use-cases + ports) and `packages/domain` (models and
policies). The transport half is unchanged.

**Why each piece is where it is:**

- **`ServerDeps` lives in `api/route-context.ts`, not in `server.ts`.** Route modules import it, and `server.ts`
  imports the route modules — keeping it in `server.ts` would be a cycle. `applyActiveWorkspace` stays the single
  owner of active-workspace logic: routes call `resolvePrincipal` and never re-implement it.
- **The slice owns both transports.** `<resource>.routes.ts` and `<resource>.mcp.ts` sit side by side, so
  BFF↔MCP parity is structural rather than a convention somebody remembers.
- **The folder is the domain entity, never a concern umbrella.** Rounds 1–2 grouped resources under
  `catalog/`, `integrations/`, `runners/`, `scheduling/`; Round 3 corrected that (maintainer-directed) to one
  folder per entity, a sub-resource nesting in its owner (harness-template in `harness/`, invite in `member/`).
- **Root = layer, inside = domain.** Round 4 restored the layer axis the entity regroup had flattened: layer
  roots at the top, the same entity name recurring inside each layer. apps/api has no storage layer — stores and
  registries are packages, injected.
- **OpenAPI is documentation only.** Each `<resource>.docs.ts` builds route descriptors from the `request/` and
  `response/` Zod schemas (reusing the `@everdict/contracts` record and spec schemas as the source of truth), and
  `@fastify/swagger` serves them at **`/docs`**. The validator and serializer compilers are no-ops, because a
  schema-carrying route would otherwise switch on ajv and fast-json-stringify and change the 400 envelopes and drop
  undeclared response fields: validation stays in the handler (`safeParse` → flat envelope). Route modules register
  in a child scope so they boot after the swagger plugin, whose `onRoute` hook only sees routes added later.

## R2-b — `ScorecardService` → facade + lifecycle collaborators

One class mixed batch orchestration, ingest, analytics reads, and progress/export tracking. It was decomposed
into collaborator services composed by a facade, so `deps.scorecards`, both transports and every existing test
stayed untouched. Today, in `packages/application-control/src/scorecard/`:

```
scorecard-service.ts            ← the facade: submit/get/list + composition; public surface unchanged
scorecard-batch-service.ts      ← the batch facade: resume + composition; what BOTH drivers ask of the batch
  in-process-batch-driver.ts    ← the in-process fan-out loop (one instance per batch — no cross-batch state)
  workflow-batch-driver.ts      ← batch contexts + plan/runBatchCase/finalize (the Temporal bridge)
  retry-failed-batch.ts         ← a terminal batch's successor (retry-failed lineage)
  resilient-case-runner.ts      ← how ONE case physically runs, shared by both drivers
  case-outcome-committer.ts     ← where a case ENDS (receipt + the child's one terminal write)
  recovery-planner.ts           ← what a re-drive must not run again
scorecard-ingest-service.ts     ← push + pull ingest lifecycles
scorecard-analytics-service.ts  ← diff / trend / leaderboard / backfillModels (reads over the store + suite)
```

Collaborators receive the stores and seams they need, never each other; the facade is the only composer. The
`ScoringService` edge stays — it is the documented scoring seam
(`execution-scoring-orchestration.md`).

## What each round did

| Round | Change |
|---|---|
| 1 | All 158 routes extracted into resource route modules; `server.ts` became a 285-line composition root. |
| 2 | MCP tools split into per-resource `<resource>.mcp.ts` modules over `mcp-context.ts`; `ScorecardService` decomposed (R2-b); `main()` grouped into per-concern builders. |
| 3 | Regrouped by domain entity instead of concern umbrellas (pure renames). |
| 4 | Restored the layer axis: `api/` · `core/` · `common/` · `infrastructure/` (pure renames). |
| 5 | `request/` + `response/` DTO folders and `<resource>.docs.ts` descriptors for every route, served at `/docs`. |

Every slice was one commit with the full apps/api suite, build and the empty-env boot contract
(`scripts/live/empty-env-boot.mjs`) green; the refactor never changed a route path, tool name or response shape.
