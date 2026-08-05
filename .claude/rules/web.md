---
paths: "apps/web/**"
---
# Web (apps/web) rules (push) — Next.js + FSD

See `docs/web.md`. This app owns its LINTING (eslint+prettier; excluded from root Biome — `pnpm -F @everdict/web
lint` is a separate CI job). Its `build` and `test` DO run in the root turbo gate, so `pnpm test` covers
`apps/web/**/*.test.ts` (vitest, via the root devDependency — the web declares no vitest of its own).

- **FSD layers** under `src/`: app → widgets → features → entities → shared. Imports go DOWNWARD only
  (a layer never imports a higher one). Barrels (`index.ts`) expose a slice's public surface.
- **A mutation must not hold the screen.** No `startTransition` around it (plain async IIFE + `useState`
  pending), no `revalidatePath` in the action, and the refresh goes through `useRefresh()`
  (`shared/lib/use-refresh`) rather than `router.refresh()`. Anything after the `await` inside a transition
  stays entangled with the router and commits only when some UNRELATED update happens — measured 26 ms to
  14.8 s for the same click, versus 41 ms / 165 ms after. See `docs/web.md`.
  Modules whose callers have no refresh of their own still carry `revalidatePath` (the action response is what
  re-renders them); migrate them to `useRefresh()` when you touch them.
- **`<Link>` comes from `shared/ui/link`, never `next/link`** (eslint-enforced): prefetch defaults to OFF,
  because on a `force-dynamic` route it only warms the shell the screen already renders while every mounted
  link re-prefetches on each router-cache invalidation.
- **Runtime-decoupled: the only allowed `@everdict` dep is TYPE-ONLY `@everdict/contracts`** (wire/record TYPES —
  re-architecture P4). The web is a pure HTTP client of the control plane; it keeps its OWN zod v4 schemas in
  `entities/*/model/schema.ts` doing all runtime boundary validation (`.parse()`), but its EXPORTED TypeScript types are
  anchored to the contracts wire/record types (`import type { RunRecord } from '@everdict/contracts'` /
  `import type { RunDetailResponse } from '@everdict/contracts/wire'`) so the local schema can no longer silently drift
  from the control plane. Rules: (1) `import type` ONLY — NEVER import a value/schema from any `@everdict/*` (the zod v3
  wire schemas must not run in the web; that would break zod-v4 isolation); (2) every local schema carries a
  compile-time **drift guard** (`type AssertAssignable<A extends B, B> = A`) binding its inferred output to the contract
  type, so a wire rename/retype fails the web typecheck; (3) `@everdict/contracts` is the ONLY permitted `@everdict`
  dependency — no `@everdict/domain`, no `@everdict/api`, etc. Identical-shape entities guard bidirectionally;
  deliberately-loose consumer views (e.g. `run.result` passthrough) source their FLAT fields from the wire and keep the
  loose sub-shape local + guarded where it overlaps.
- **Auth**: the web is a **BFF token courier, not an auth authority**. Auth.js stores/refreshes the Keycloak
  access token (`jwt` callback) in the **server-only httpOnly cookie** — NEVER put it on the `session` (no
  `/api/auth/session` leak); read it server-side via `getAccessToken()` (`getToken`). `control-plane.ts` forwards
  it as `Authorization: Bearer <jwt>`. NEVER decode the token for `workspace`/roles — those come from the control
  plane's `GET /me` (`currentPrincipal`). UI role-gating uses the `shared/auth/can.ts` mirror, but enforcement is
  the control plane's (403). Dev (no Keycloak) falls back to `authContext()` → `x-everdict-tenant=default`. Never
  call the control plane from the browser (all calls are `server-only`); guard `auth()` behind `keycloakConfigured`
  so dev works without `AUTH_SECRET`.
- **Workspace URLs (Linear-style)**: routes live under `app/[workspace]/*`; the URL's first path segment **is**
  the active workspace. `middleware` injects it as the `x-everdict-active-workspace` request header (and syncs the
  most-recent `everdict-workspace` cookie); `authContext` reads that header (cookie fallback) → forwards
  `x-everdict-workspace`. So pages/actions scope to the URL workspace with NO per-page param threading — don't
  reintroduce a cookie-only or per-page-`params` scoping path. `[workspace]/layout` is the authoritative validator
  (redirect on non-member / 0-workspace / null principal). Nav hrefs are workspace-relative **suffixes**
  (`nav-config`) prefixed with the active workspace at render; switching workspace = `router.push('/'+id)` (no
  action). Slug-less entry points (`onboarding`/`new-workspace`/`invite`) stay top-level, never under `[workspace]`;
  keep their slugs reserved. Shared URL↔cookie↔header constants live in `shared/auth/workspace-scope.ts`
  (non-`server-only`, importable from middleware).
- **A collection is PLURAL, one thing is SINGULAR** (Linear's spelling): `/{ws}/scorecards` is the list,
  `/{ws}/scorecard/{id}` is one — and the collection's own named screens keep the plural (`…/scorecards/new`).
  `/teams` is the directory; one team is `/{ws}/team/ENG/…`. Moved addresses redirect via `next.config.ts`
  `DETAIL_MOVES`. An issue's title rides as a decorative trailing slug that nothing reads.
- **A list's FILTERS live in the URL; its DISPLAY lives with the reader.** Which issues (status/priority/label/…)
  is a query parameter, so a pasted link opens the same set for everyone. How they are drawn (grouping, ordering,
  layout, show-completed, sub-issues) is NEVER in the URL — a link must not rearrange the recipient's screen — and
  is stored per view in the `everdict-issue-display` cookie (`entities/issue/model/display.ts`, written by the
  `setIssueDisplay` action). Cookie rather than localStorage because the list is a server component.
- **Styling**: Tailwind v4 tokens in `globals.css` `@theme inline` (**Linear-style**: indigo `#5e6ad2` primary,
  tight radius `0.5rem`, near-black `#08090a` dark surface, thin low-alpha borders, top indigo glow + subtle
  grain overlay); `cn()` from `shared/lib/utils`. shadcn new-york conventions. Light **and** dark themes via the
  `.dark` class — toggled by `shared/ui/theme-toggle` (no `next-themes`: `html.dark` + `localStorage`), with a
  no-flash inline script in `app/layout.tsx` (stored choice → else `prefers-color-scheme`).
- **i18n**: user-facing copy is NEVER hardcoded — next-intl catalogs `messages/{ko,en}.json` (add new strings
  to BOTH). Locale = cookie > Accept-Language > `en` (`shared/i18n/`), NO `/[locale]` URL segment (first path
  segment stays the workspace). `useTranslations()` in client, `getTranslations()` in server components; static
  configs store message keys (`labelKey`) resolved at render. Switcher = `features/switch-locale`.
- **Tooling**: `pnpm --filter @everdict/web {dev,build,lint}`. Don't add it to the root Biome ignore-list removal.
