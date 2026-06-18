---
paths: "apps/web/**"
---
# Web (apps/web) rules (push) — Next.js + FSD, reinterpreted from digo-admin

See `docs/web.md`. This app is SELF-CONTAINED (own eslint+prettier; excluded from root Biome/turbo gate).

- **FSD layers** under `src/`: app → widgets → features → entities → shared. Imports go DOWNWARD only
  (a layer never imports a higher one). Barrels (`index.ts`) expose a slice's public surface.
- **No `@assay/*` package deps.** The web is a pure HTTP client of the control plane (`@assay/api`); mirror API
  shapes with local zod schemas in `entities/*/model/schema.ts`. Keeps web ↔ api decoupled (and zod v4 isolated).
- **Auth**: the web is a **token courier, not an auth authority**. Auth.js stores/refreshes the Keycloak access
  token (`jwt` callback); server-only `control-plane.ts` forwards it as `Authorization: Bearer <jwt>`. NEVER
  decode the token for `workspace`/roles — those come from the control plane's `GET /me` (`currentPrincipal`).
  UI role-gating uses the `shared/auth/can.ts` mirror, but enforcement is the control plane's (403). Dev (no
  Keycloak) falls back to `authContext()` → `x-assay-tenant=default`. Never call the control plane from the
  browser (all calls are `server-only`); guard `auth()` behind `keycloakConfigured` so dev works without `AUTH_SECRET`.
- **Styling**: Tailwind v4 tokens in `globals.css` `@theme inline` (Toss-style: blue primary, generous radius);
  `cn()` from `shared/lib/utils`. shadcn new-york conventions.
- **Tooling**: `pnpm --filter @assay/web {dev,build,lint}`. Don't add it to the root Biome ignore-list removal.
