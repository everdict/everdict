---
paths: "apps/web/**"
---
# Web (apps/web) rules (push) — Next.js + FSD

See `docs/web.md`. This app is SELF-CONTAINED (own eslint+prettier; excluded from root Biome/turbo gate).

- **FSD layers** under `src/`: app → widgets → features → entities → shared. Imports go DOWNWARD only
  (a layer never imports a higher one). Barrels (`index.ts`) expose a slice's public surface.
- **No `@assay/*` package deps.** The web is a pure HTTP client of the control plane (`@assay/api`); mirror API
  shapes with local zod schemas in `entities/*/model/schema.ts`. Keeps web ↔ api decoupled (and zod v4 isolated).
- **Auth**: the web is a **BFF token courier, not an auth authority**. Auth.js stores/refreshes the Keycloak
  access token (`jwt` callback) in the **server-only httpOnly cookie** — NEVER put it on the `session` (no
  `/api/auth/session` leak); read it server-side via `getAccessToken()` (`getToken`). `control-plane.ts` forwards
  it as `Authorization: Bearer <jwt>`. NEVER decode the token for `workspace`/roles — those come from the control
  plane's `GET /me` (`currentPrincipal`). UI role-gating uses the `shared/auth/can.ts` mirror, but enforcement is
  the control plane's (403). Dev (no Keycloak) falls back to `authContext()` → `x-assay-tenant=default`. Never
  call the control plane from the browser (all calls are `server-only`); guard `auth()` behind `keycloakConfigured`
  so dev works without `AUTH_SECRET`.
- **Workspace URLs (Linear-style)**: routes live under `app/[workspace]/*`; the URL's first path segment **is**
  the active workspace. `middleware` injects it as the `x-assay-active-workspace` request header (and syncs the
  most-recent `assay-workspace` cookie); `authContext` reads that header (cookie fallback) → forwards
  `x-assay-workspace`. So pages/actions scope to the URL workspace with NO per-page param threading — don't
  reintroduce a cookie-only or per-page-`params` scoping path. `[workspace]/layout` is the authoritative validator
  (redirect on non-member / 0-workspace / null principal). Nav hrefs are workspace-relative **suffixes**
  (`nav-config`) prefixed with the active workspace at render; switching workspace = `router.push('/'+id)` (no
  action). Slug-less entry points (`onboarding`/`new-workspace`/`invite`) stay top-level, never under `[workspace]`;
  keep their slugs reserved. Shared URL↔cookie↔header constants live in `shared/auth/workspace-scope.ts`
  (non-`server-only`, importable from middleware).
- **Styling**: Tailwind v4 tokens in `globals.css` `@theme inline` (**Linear-style**: indigo `#5e6ad2` primary,
  tight radius `0.5rem`, near-black `#08090a` dark surface, thin low-alpha borders, top indigo glow + subtle
  grain overlay); `cn()` from `shared/lib/utils`. shadcn new-york conventions. Light **and** dark themes via the
  `.dark` class — toggled by `shared/ui/theme-toggle` (no `next-themes`: `html.dark` + `localStorage`), with a
  no-flash inline script in `app/layout.tsx` (stored choice → else `prefers-color-scheme`).
- **Tooling**: `pnpm --filter @assay/web {dev,build,lint}`. Don't add it to the root Biome ignore-list removal.
