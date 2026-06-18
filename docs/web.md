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
app/        Next App Router — landing, dashboard/{layout(shell), page(overview), runs, runs/[id], harnesses},
            api/auth/[...nextauth], middleware
widgets/    page-level composition: app-shell (sidebar+topbar), scorecard-summary, runs-table, trace-timeline
features/   business actions: submit-run, register-harness (client form + 'use server' action → control plane)
entities/   domain models + zod schemas mirroring the API (run + trace/snapshot, harness)
shared/     ui (button/card/badge/page-header/stat-card/status-pill/empty-state), lib (utils, control-plane),
            config (env), providers (query), auth (Keycloak + currentTenant)
```
Import order enforces downward layer deps (app → widgets → features → entities → shared).

## Screens
- **개요 `/dashboard`** — scorecard stat cards (total / success / fail / pass-rate) + recent runs + harness summary.
- **Runs `/dashboard/runs`** — full runs table (rows link to detail).
- **Run detail `/dashboard/runs/[id]`** — status, meta, scores, **trace timeline**, snapshot, error.
- **하니스 `/dashboard/harnesses`** — owned vs `_shared` harnesses with versions.
- **새 run `/dashboard/runs/new`** — submit-run form (react-hook-form) → `submitRunAction` (server action) →
  control plane `POST /runs` → redirect to the run detail.
- **하니스 등록 `/dashboard/harnesses/new`** — register-harness form (HarnessSpec JSON) → `registerHarnessAction`
  → control plane `POST /harnesses` (409 on the immutable-version violation, surfaced inline).
All under a shared app shell (sidebar nav + topbar tenant chip / sign-in-out). Mutations are **server actions**
(`'use server'`) that resolve the tenant and call the control plane server-side, then `revalidatePath`.

The dev server runs on **port 3001** (`pnpm --filter @assay/web dev`).

## Run
```bash
pnpm install
# control plane (separate terminal): node apps/api/dist/main.js   (or with DATABASE_URL for Postgres)
# Keycloak (optional; without it the web runs in dev mode as tenant "default"):
docker compose -f deploy/keycloak/docker-compose.yaml up -d        # then configure realm/client (see file)
cp apps/web/.env.example apps/web/.env                              # set CONTROL_PLANE_URL + Keycloak vars
pnpm --filter @assay/web dev                                       # http://localhost:3001
```
Without Keycloak configured, `/dashboard` renders for tenant `default` (no login required) — handy for local dev.
With Keycloak configured, `/dashboard` is protected (middleware redirects to login) and the tenant comes from the
authenticated user. The dashboard degrades gracefully if the control plane is unreachable.

## Verified
`next build` compiles + type-checks (routes `/`, `/dashboard` [dynamic], `/api/auth/[...nextauth]`, middleware);
`/dashboard` renders server-side (scorecard + runs + harnesses for the resolved tenant). Root gate (Biome /
turbo typecheck / test) stays green with `apps/web` self-contained.
