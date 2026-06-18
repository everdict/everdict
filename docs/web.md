# SaaS web (`apps/web`)

The multi-tenant SaaS frontend — a Next.js app (FSD architecture, Toss-style design) where tenant **users**
log in (Keycloak), see their **per-tenant scores**, runs, and harnesses. Reference architecture: digo-admin.

## Two complementary auth paths
- **Humans → Keycloak (OIDC)** via Auth.js in `apps/web`. The tenant is derived from a token claim
  (`TENANT_CLAIM`, default `tenant`). The web is a trusted gateway: it authenticates the user, then calls the
  control plane (`@assay/api`) server-side, forwarding `x-assay-tenant`.
- **Agents / MCP / CI → API keys** (the `@assay/db` tenant-key layer) calling `@assay/api` directly with
  `Authorization: Bearer ak_…`. (MCP toolization of the platform — exposing run/harness actions as agent tools —
  is the next slice, served from `@assay/api`, reusing this key auth.)

These don't conflict: Keycloak = people in the browser, API keys = machines.

## Stack (mirrors digo-admin)
Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 (`@theme inline` tokens) · shadcn-style UI
(new-york, neutral base, **Toss-style** blue primary + generous radius) · TanStack Query · zod · Auth.js +
Keycloak. Self-contained tooling: **eslint + prettier** (import-order plugin) — NOT the repo Biome (apps/web is
excluded from root Biome). The web is a pure HTTP client of the control plane — **no `@assay/*` package deps**.

## FSD layout (`src/`)
```
app/        Next App Router (layout, page, dashboard, api/auth/[...nextauth])
widgets/    page-level composition (scorecard-summary, runs-table)
features/   business actions (e.g. submit-run, register-harness) — grow here
entities/   domain models + zod schemas mirroring the API (run, harness)
shared/     ui, lib (utils, control-plane client), config (env), providers (query), auth (Keycloak)
```
Import order enforces downward layer deps (app → widgets → features → entities → shared).

## Run
```bash
pnpm install
# control plane (separate terminal): node apps/api/dist/main.js   (or with DATABASE_URL for Postgres)
# Keycloak (optional; without it the web runs in dev mode as tenant "default"):
docker compose -f deploy/keycloak/docker-compose.yaml up -d        # then configure realm/client (see file)
cp apps/web/.env.example apps/web/.env                              # set CONTROL_PLANE_URL + Keycloak vars
pnpm --filter @assay/web dev                                       # http://localhost:3000
```
Without Keycloak configured, `/dashboard` renders for tenant `default` (no login required) — handy for local dev.
With Keycloak configured, `/dashboard` is protected (middleware redirects to login) and the tenant comes from the
authenticated user. The dashboard degrades gracefully if the control plane is unreachable.

## Verified
`next build` compiles + type-checks (routes `/`, `/dashboard` [dynamic], `/api/auth/[...nextauth]`, middleware);
`/dashboard` renders server-side (scorecard + runs + harnesses for the resolved tenant). Root gate (Biome /
turbo typecheck / test) stays green with `apps/web` self-contained.
