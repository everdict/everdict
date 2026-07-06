---
name: web
description: The SaaS web app (apps/web) — Next.js 16 App Router, FSD layers, a pure-HTTP token-courier BFF over the control plane with Linear-style [workspace] URL scoping. Use when editing apps/web (Next.js FSD web app).
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Web (apps/web) — Next.js FSD BFF

The multi-tenant frontend. A **pure HTTP client** of `@assay/api` (no `@assay/*` deps) and a **token
courier, not an auth authority**: it forwards the user's Keycloak token and trusts the control plane.

## Checklist
1. **Layer down only**: `app → widgets → features → entities → shared` (`src/`). Never import upward.
   Cross-slice imports go through a slice's barrel `index.ts`, never deep paths.
2. **Mirror API shapes with local zod** in `entities/<name>/model/schema.ts` (no `@assay/*` import);
   `.parse()` every control-plane response. Re-export via the entity's `index.ts`.
3. **All control-plane calls are `server-only`** via `shared/lib/control-plane.ts` (`controlPlane.*`) —
   never fetch from the browser. Pass `AuthContext` from `authContext()` / `currentPrincipal()`.
4. **Pages = server components** that fetch + `.parse()` and pass plain props to `'use client'` islands;
   mutations are `'use server'` server actions that forward the token then `revalidatePath`.
5. **Role-gate UI** with the `shared/auth/can.ts` mirror (`can(roles, action)`) — enforcement is still the
   control plane's (403). Hide the CTA; don't rely on it for security.
6. Web is SELF-CONTAINED (own eslint/prettier, excluded from root Biome/turbo). Tooling:
   `pnpm --filter @assay/web {dev,build,lint}` (dev = port 3001). **Never run repo-wide formatters** in
   this shared WIP tree — format only files you changed.

## Reference impl
A full slice: `features/submit-run/` — `ui/submit-run-form.tsx` (`'use client'` react-hook-form island) +
`api/submit-run.ts` (`'use server'` action → `controlPlane.submitRun` → `revalidatePath`) exposed via
`index.ts`; the page `app/[workspace]/runs/page.tsx` fetches server-side and gates the CTA with `can(...)`.

## Auth = token courier (BFF), not authority
- Auth.js keeps the Keycloak access token in a **server-only httpOnly cookie**, NEVER on the client
  `session` (no `/api/auth/session` leak). Read it server-side via `getAccessToken()`
  (`shared/auth/access-token.ts`); `control-plane.ts` forwards `Authorization: Bearer <jwt>`.
- `workspace` + roles come ONLY from `GET /me` (`currentPrincipal()` in `shared/auth/principal.ts`) —
  NEVER decode the token. Dev (no Keycloak) falls back to `x-assay-tenant=default` (`via !== 'oidc'`).
- Actions/pages: `authContext()` for a mutation, `currentPrincipal()` when you also need `principal`.

## `[workspace]` URL scoping (Linear-style)
The URL's first path segment **is** the active workspace. `middleware.ts` injects it as the
`x-assay-active-workspace` header (constants in `shared/auth/workspace-scope.ts`, non-`server-only` so
middleware can import it) + syncs the `assay-workspace` cookie; `authContext()` reads the header and
forwards `x-assay-workspace`. So there is NO per-page `params` threading for scope — don't reintroduce a
cookie-only path. `app/[workspace]/layout.tsx` is the authoritative validator (redirect on null principal
/ 0 workspaces / non-member). Nav hrefs are workspace-relative **suffixes** (`widgets/app-shell/ui/nav-config.ts`),
prefixed at render; switching workspace = `router.push('/'+id)`. Slug-less entry points stay top-level
(`RESERVED_TOP_LEVEL`: `onboarding`/`new-workspace`/`invite`/`api`).

## Styling
Tailwind v4 tokens in `app/globals.css` `@theme inline` (Linear indigo `#5e6ad2`, tight `0.5rem` radius,
near-black `#08090a` dark surface). Light+dark via the `.dark` class (`@custom-variant dark`) toggled by
`shared/ui/theme-toggle` — NO `next-themes`; no-flash inline script in `app/layout.tsx`. `cn()` from
`shared/lib/utils.ts`; shadcn new-york atoms under `shared/ui/`. Dropdowns are always `shared/ui/combobox`.

## Established UI conventions (enforced — reuse, don't reinvent)
- **Format atoms**: score/model/version/time formatting goes through `shared/lib/format.ts` +
  `shared/ui/{score,chip}.tsx`, NEVER per-page inline.
- **Settings UIs** = Linear settings-list (`shared/ui/settings-list.tsx`, label-left / compact-control-right
  divided rows), not stacked full-width forms.
- **Guide/help copy is never inline** — render an info icon via `shared/ui/tooltip.tsx` (`InfoTip`), reveal
  on hover. Field-level `<p>` hints under inputs are fine; panel/list guidance is not.
- **Detail views**: hide empty sections entirely (no "없음" placeholder); entities show a meta strip, not a
  bare `dl` grid.
- **State toggles** = a status icon + click dropdown (`shared/ui/dropdown-menu.tsx`; e.g.
  `widgets/notification-bell/`), not text links.

## Language (per CLAUDE.md)
Skill/rule bodies English; **code comments Korean**, user-facing UI copy Korean.

See `docs/web.md` (screens + run) + `docs/auth.md` + `docs/tenancy.md`; the rule `web.md` has the inlined
critical rules.
