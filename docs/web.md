# SaaS web (`apps/web`)

The multi-tenant SaaS frontend — a Next.js app (FSD architecture, Toss-style design) where tenant **users**
log in (Keycloak), see their **per-tenant scores**, runs, and harnesses. Reference architecture: digo-admin.

## Two complementary auth paths
- **Humans → Keycloak (OIDC)** via Auth.js in `apps/web`. The web is a **BFF token courier, not an auth
  authority**: Auth.js stores (and refreshes) the Keycloak **access token** in the **server-only httpOnly
  encrypted cookie** — it is **never put on the client session** (no `/api/auth/session` leak). The server reads
  it via `getAccessToken()` (`getToken` over the cookie) and `control-plane.ts` forwards it as
  `Authorization: Bearer <jwt>` to `@assay/api`. The control plane resolves identity — `workspace` + roles come
  from `GET /me`, never decoded from the token by the web. UI is role-gated off `/me` (mirror in
  `shared/auth/can.ts`), but enforcement is always the control plane's (403). Without Keycloak configured the web
  falls back to the dev `x-assay-tenant=default` path. See `docs/auth.md`.
- **Agents / MCP / CI → API keys** (the `@assay/db` tenant-key layer) calling `@assay/api` directly with
  `Authorization: Bearer ak_…`. (MCP toolization of the platform — exposing run/harness actions as agent tools —
  is the next slice, served from `@assay/api`, reusing this key auth.)

These don't conflict: Keycloak = people in the browser, API keys = machines. Both resolve to the same
control-plane `Principal{workspace, roles}`.

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
            config (env), providers (query), auth (Keycloak token store/refresh, server-only access-token (getToken),
            authContext + currentPrincipal + can)
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
The **새 run** and **하니스 등록** pages (and their list-page CTAs) are role-gated off `/me`: a viewer sees a
"권한이 없습니다" notice instead of the form, a member can submit runs, only an admin can register harnesses.
All under a shared app shell (sidebar nav + topbar **workspace + role** chip / sign-in-out). Mutations are
**server actions** (`'use server'`) that forward the user's token and call the control plane server-side, then
`revalidatePath`.

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
Without Keycloak configured, `/dashboard` renders for the dev `default` workspace (no login required) — handy for
local dev. With Keycloak configured, `/dashboard` is protected (middleware redirects to login) and the
workspace/roles come from the control plane's `GET /me` over the forwarded token. The dashboard degrades
gracefully if the control plane is unreachable.

## Verified
`next build` compiles + type-checks (9 routes); root gate (Biome / turbo typecheck / test) stays green with
`apps/web` self-contained. **Live (headless OAuth, real Keycloak)** via `scripts/live/web-auth-flow.py`: drives
the Auth.js + Keycloak authorization-code flow with a cookie jar (no browser) for `alice` (member) and `carol`
(admin) → the web forwards each user's token → `/dashboard` shows `workspace=acme` (from `/me`); `runs/new` is
allowed for both; `harnesses/new` is gated for the member and allowed for the admin. **BFF hardening proven**: the
same script asserts `/api/auth/session` carries **no** access token (no `eyJ…`/`accessToken` leak) while the
server-side path still works — the token lives only in the httpOnly cookie.
