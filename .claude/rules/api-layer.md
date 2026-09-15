---
paths: "apps/api/**"
---
# API layer rules (push) — transport slices over the spine

`apps/api` is the control plane's transport and composition over the layer spine. The recipe is skill `api-layer`;
why it is shaped this way is `docs/architecture/api-route-modularization.md`.

- **Business code does not live in `apps/api`.** Use-case services and the store/registry ports they take are in
  `packages/application-control/src/<domain>/` (`RunService`, `ScorecardService`, `executeCase`, `ScoringService`);
  domain models and policies are in `packages/domain/src/<domain>/` (`Run`, `MembershipPolicy`). A new service or
  model goes there, never into `apps/api/src/core/`. Storage is `@everdict/db` + `@everdict/registry`, injected.
- **What `apps/api/src/` holds, by root:**
  - `api/<domain>/` — the transport slice, one folder per domain entity: `<resource>.routes.ts` (HTTP),
    `<resource>.mcp.ts` (the same resource's MCP tools), `<resource>.docs.ts` (OpenAPI descriptors),
    `request/<dto>.ts` (only when the resource has bodies) and `response/<dto>.ts` (only what no
    `@everdict/contracts` record/spec schema already covers). A sub-resource lives in its owner's folder
    (harness-template in `harness/`, invite in `member/`); never a concern umbrella (`catalog/`, `integrations/`).
  - `core/` — app-bound code that did not move to a package: dispatchers, backends and the judge runner
    (`core/execution/`), runtime inspect/probe/control (`core/ops/`), the Temporal drivers, and a few services bound
    to an adapter package. It is not where business logic goes.
  - `common/` (cross-cutting helpers), `infrastructure/` (external clients), `composition/` (wiring builders).
  - Imports run one way — `common ← infrastructure ← core ← api` — and only `main.ts` imports `composition/`.
- **Composition roots stay thin.** `server.ts`: app construction, parsers, swagger, WS upgrade and the
  `register<X>Routes(app, deps)` calls — no route bodies. `mcp.ts`: the McpServer and the `register<X>Tools(server,
  ctx)` calls — no tool bodies. `mcp.routes.ts`: the `/mcp` transport and session map. `main.ts`: env → deps over the
  `composition/` builders — no business logic.
- **Shared context is `api/route-context.ts`** (`ServerDeps`, `resolvePrincipal`, `applyActiveWorkspace`, `gate`,
  `sendError`). Never re-implement auth in a route; active-workspace logic has one owner. See rule `auth`.
- **Routes are thin — the fixed handler shape:** ① feature gate (`if (!deps.xService)` → 404) → ② `resolvePrincipal`
  → ③ `gate(principal, action)` → ④ `safeParse` → 400 → ⑤ delegate a command object to the service → ⑥ `sendError`.
  Anything conditional beyond that belongs in the service; services never touch req/reply or status codes, and a
  route returns the service result verbatim. A handler may call a store directly only for envelope-free trivial
  CRUD (secrets list/set/remove).
- **Services: one direction, no peer calls.** transport → service → store/registry. Peer resource services never call
  each other; the only sanctioned seams are orchestration → `ScoringService` / `executeCase`, and a new one is argued
  in `docs/architecture/execution-scoring-orchestration.md` first. A service that accretes distinct lifecycles splits
  into collaborators behind a facade that keeps `deps.<x>` stable.
- **The domain expresses itself.** A lifecycle gets a model with guard methods and transitions that return the store
  patch (`Run.from(record)`); a service never writes a `status:` literal or re-derives legality. See
  `docs/architecture/rich-domain-core.md`.
- **BFF↔MCP parity is structural:** both transports live in the slice and call the same service function.
- **No hypothetical surface.** A field, parameter or endpoint exists only if it has a current caller.
- Responses are **flat**; errors are `{ code, message, data? }` from `AppError.toEnvelope()` via `sendError`.
- **OpenAPI is documentation only**: `.routes.ts` attaches `{ schema: docs.x }`; the validator/serializer compilers
  are no-ops, so attaching a schema must never change behaviour. English text.
- POST defaults to **200** (201 allowed, consistent per resource). No `/api` prefix. Lists paginate by cursor
  (`created_at DESC, id DESC`, fetch `size+1`, opaque base64 token) with no wrapper.
- `/internal/**` is guarded by `x-internal-token` (constant-time compare, fail-closed if unset).
- **Route-move gotchas:** a route path may sit on its own line (`app.get<…>(\n  "/x/:id",`); check an exported
  schema's consumers before moving it; the `buildServer`+`inject` suite must stay green and the surface identical.
