---
name: web
description: The SaaS web app (apps/web) — Next.js 16 App Router, FSD layers, a pure-HTTP token-courier BFF over the control plane with Linear-style [workspace] URL scoping. Use when editing apps/web (Next.js FSD web app).
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Web (apps/web) — Next.js FSD BFF

The multi-tenant frontend. A **pure HTTP client** of `@everdict/api` (no `@everdict/*` deps) and a **token
courier, not an auth authority**: it forwards the user's Keycloak token and trusts the control plane.

## Checklist
1. **Layer down only**: `app → widgets → features → entities → shared` (`src/`). Never import upward.
   Cross-slice imports go through a slice's barrel `index.ts`, never deep paths.
2. **Mirror API shapes with local zod** in `entities/<name>/model/schema.ts` (no `@everdict/*` import);
   `.parse()` every control-plane response. Re-export via the entity's `index.ts`.
3. **All control-plane calls are `server-only`** via `shared/lib/control-plane.ts` (`controlPlane.*`) —
   never fetch from the browser. Pass `AuthContext` from `authContext()` / `currentPrincipal()`.
4. **Pages = server components** that fetch + `.parse()` and pass plain props to `'use client'` islands;
   mutations are `'use server'` server actions that forward the token then `revalidatePath`.
5. **Role-gate UI** with the `shared/auth/can.ts` mirror (`can(roles, action)`) — enforcement is still the
   control plane's (403). Hide the CTA; don't rely on it for security.
6. Web is SELF-CONTAINED (own eslint/prettier, excluded from root Biome/turbo). Tooling:
   `pnpm --filter @everdict/web {dev,build,lint}` (dev = port 3001). **Never run repo-wide formatters** in
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
  NEVER decode the token. Dev (no Keycloak) falls back to `x-everdict-tenant=default` (`via !== 'oidc'`).
- Actions/pages: `authContext()` for a mutation, `currentPrincipal()` when you also need `principal`.

## `[workspace]` URL scoping (Linear-style)
The URL's first path segment **is** the active workspace. `middleware.ts` injects it as the
`x-everdict-active-workspace` header (constants in `shared/auth/workspace-scope.ts`, non-`server-only` so
middleware can import it) + syncs the `everdict-workspace` cookie; `authContext()` reads the header and
forwards `x-everdict-workspace`. So there is NO per-page `params` threading for scope — don't reintroduce a
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
  divided rows), not stacked full-width forms. **Settings content width is ONE shared column**: every settings
  tab — form/account (General · Profile · Preferences · API keys · Personal secrets) AND data-dense (Members ·
  Secrets · Models · Integrations · Observability · CI · Runners · Budget) — renders inside the single
  `app/[workspace]/settings/layout.tsx` wrapper (centered `max-w-5xl`), so the content's left/right edges never
  shift between tabs. A page just starts with its own `<div className="space-y-6">` (no per-page width class,
  no inline `max-w-*` — the layout owns width). The former two-tier `SettingsColumn` split was removed.
- **Guide/help copy is never inline** — render an info icon via `shared/ui/tooltip.tsx` (`InfoTip`), reveal
  on hover. Field-level `<p>` hints under inputs are fine; panel/list guidance is not.
- **Detail views**: hide empty sections entirely (no "none" placeholder); entities show a meta strip, not a
  bare `dl` grid.
- **State toggles** = a status icon + click dropdown (`shared/ui/dropdown-menu.tsx`; e.g.
  `widgets/notification-bell/`), not text links.
- **Infra split view** (`widgets/infra-panel`): infra concerns (schedules · runtimes · runs · work queue) open
  in the floating right panel toggled by the vertical rail — eval pages stay on the left half, and the sidebar
  is eval-only (don't re-add runs/schedules/runtimes nav entries; the palette's infra group opens the panel
  via `openTab`). **The page tabs host the REAL routed pages in same-origin iframes** (user decision — never
  re-implement infra pages as panel summaries, and no "full page" links): the [workspace] layout detects the
  iframe (sec-fetch-dest / `?embed=1`→`x-everdict-embed`) and hands `ShellSwitch` an embed hint whose framed
  state is STICKY (the dynamic layout re-renders on soft nav without the signals — don't move the decision
  back to the server). `EmbedShell` renders pages chrome-less and escapes eval-axis links to the parent
  (`everdict:left-nav` → left router); infra links stay in-iframe. Deep entries = `useInfraPanel().openRun/
  openRuntime/openSchedule` (iframe `src` is frozen at first mount — deep-opens go through
  `contentWindow.location`, never the src prop, or React would undo the user's in-iframe navigation).
- **Secret-name inputs** are never free text — use `SecretPicker` from `features/pick-secret`
  (combobox over preloaded names + "new" inline create; `defaultMultiline` for PEM/kubeconfig).
  Used by harness env, GHE App private key, Mattermost tokens.

## Language & i18n (per CLAUDE.md)
Skill/rule bodies English; **code comments Korean**. User-facing UI copy is **never hardcoded** —
it lives in next-intl catalogs `messages/{ko,en}.json` (add every new string to BOTH in the same PR).
Locale is **cookie-based** (`shared/i18n/`: cookie > Accept-Language > `en`) — NO `/[locale]` URL
segment (the first path segment stays the workspace). Client components use `useTranslations()`,
server components `getTranslations()` (`next-intl/server`); the switcher is `features/switch-locale`
(sidebar footer). Static module configs (e.g. `nav-config.ts`) store message **keys** (`labelKey`),
resolved with `t()` at render. Reference migration: `widgets/app-shell`.

See `docs/web.md` (screens + run) + `docs/auth.md` + `docs/tenancy.md`; the rule `web.md` has the inlined
critical rules.
