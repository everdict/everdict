import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

// A relative import, not the `@/` alias: this module is read while Next is still booting its config.
import { RESERVED_TOP_LEVEL } from './src/shared/auth/workspace-scope'
import { DETAIL_ROUTES } from './src/shared/lib/resource-routes'

// i18n request config (cookie-based locale — no URL routing). Catalogs are messages/{ko,en}.json.
const withNextIntl = createNextIntlPlugin('./src/shared/i18n/request.ts')

// The addresses that moved when detail routes went singular — `/{ws}/scorecards/{id}` → `/{ws}/scorecard/{id}`.
// A COLLECTION keeps its plural (`/{ws}/scorecards` is still the list), so only an address with something after
// the collection segment moves, and only when that something is an id rather than one of the collection's own
// named screens. Those names come from the shared table and are excluded by a lookahead: without it,
// `/scorecards/new` would redirect to `/scorecard/new`, which is nothing.
//
// The table is shared with the sidebar (`src/shared/lib/resource-routes.ts`) — both places have to agree on the
// pairing, and each deriving it separately is what left detail pages lighting no nav row.
const DETAIL_MOVES = DETAIL_ROUTES

// Not permanent (307, not 308) on purpose: a browser caches a permanent redirect hard enough that reverting the
// scheme would strand anyone who had followed one. Promote these to `permanent: true` once the singular
// addresses have been confirmed live.
// ── EVERY ADDRESS A TEAM USED TO OWN ──────────────────────────────────────────────────────────────
//
// The team axis is gone (migrations `0211`/`0212`) and every collection has ONE workspace address, so a link
// pasted while teams existed must land on that address rather than a 404. `cycles` and `triage` had no
// workspace twin — the concepts went with the team — so they land on the issue list, which is where the work
// they held now lives.
const FORMER_TEAM_SECTIONS = {
  scorecards: 'scorecards',
  harnesses: 'harnesses',
  datasets: 'datasets',
  judges: 'judges',
  projects: 'projects',
  issues: 'issues',
  triage: 'issues',
  cycles: 'issues',
} as const

// Only an address whose FIRST segment is a workspace is subject to these rules — a reserved word such as `api` is not a workspace
// (`RESERVED_TOP_LEVEL`, the same list the middleware reads). Without the guard our BFF routes are caught wholesale:
// `/api/issues/:id/attachment` 307s to `/api/issue/:id/attachment` (an address that does not exist), and the GitHub attachment images in an
// issue body and the run recording downloads die quietly — the routes are fine and the requests never reach them.
// ⚠️ A segment ends with `(?:/|$)` rather than `$`: in the regex path-to-regexp builds, `$` means the end of the **whole path**, so a first
// segment with anything after it never matches (which disables the guard entirely).
const WORKSPACE = `:workspace((?!(?:${[...RESERVED_TOP_LEVEL].join('|')})(?:/|$))[^/]+)`

async function movedDetailRoutes() {
  return [
    ...Object.entries(FORMER_TEAM_SECTIONS).flatMap(([section, landing]) =>
      // Both spellings of the team segment, and anything under them (`…/scorecards/new` included).
      ['team', 'teams'].map((segment) => ({
        source: `/${WORKSPACE}/${segment}/:key/${section}/:rest*`,
        destination: `/:workspace/${landing}`,
        permanent: false,
      }))
    ),
    // A bare team address was that team's issue list. Matched AFTER the section rules above, which are more
    // specific, and it also catches `…/settings/teams/:key` because a team has no settings to open any more.
    ...['team', 'teams'].map((segment) => ({
      source: `/${WORKSPACE}/${segment}/:key/:rest*`,
      destination: '/:workspace/issues',
      permanent: false,
    })),
    { source: `/${WORKSPACE}/teams`, destination: '/:workspace/members', permanent: false },
    { source: `/${WORKSPACE}/cycles/:rest*`, destination: '/:workspace/issues', permanent: false },
    { source: `/${WORKSPACE}/cycle/:rest*`, destination: '/:workspace/issues', permanent: false },
    { source: `/${WORKSPACE}/settings/teams/:rest*`, destination: '/:workspace/settings', permanent: false },
    ...DETAIL_MOVES.map(({ plural, singular, reserved }) => {
      const guard = reserved.length === 0 ? '' : `(?!(?:${reserved.join('|')})$)`
      return {
        source: `/${WORKSPACE}/${plural}/:id(${guard}[^/]+)/:rest*`,
        destination: `/:workspace/${singular}/:id/:rest*`,
        permanent: false,
      }
    }),
  ]
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  redirects: movedDetailRoutes,
  // undici is not bundled and is required from node_modules at runtime — so instrumentation's setGlobalDispatcher operates with the same
  // instance semantics as the global symbol Node's built-in fetch reads (the Symbol.for registry), which is what makes proxy support work.
  serverExternalPackages: ['undici'],
  // If dev and build share the same .next, in this shared WIP tree another session's next build pollutes the dev turbopack
  // cache (SST persist failure / buildManifest ENOENT → hydration dies and every click is unresponsive).
  // pnpm dev isolates it via NEXT_DIST_DIR=.next-dev (build keeps the default .next — no production impact).
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // If the dev server binds 0.0.0.0 and you connect via a LAN/Tailscale IP·localhost, Next 16 treats that origin
  // as a "cross-origin dev resource" and blocks /_next/webpack-hmr (HMR / turbopack runtime bootstrap).
  // → the runtime never initializes, so React hydration never happens and every onClick dies (only links still work).
  // Explicitly allow the connecting origin to lift the block (dev-only setting, no production impact).
  // Extra origins like LAN/Tailscale go through EVERDICT_DEV_ORIGIN (.env.local) — don't hardcode a personal host in the repo.
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    ...(process.env.EVERDICT_DEV_ORIGIN ? [process.env.EVERDICT_DEV_ORIGIN] : []),
  ],
  // Dataset registration / new-version deploy easily exceeds the default 1MB limit for case JSON (embedded repo seed files)
  // (e.g. pinch-runnable ≈ 1.1MB) — raise the server-action body limit generously. The control plane does the real validation.
  experimental: { serverActions: { bodySizeLimit: '8mb' } },
}

export default withNextIntl(nextConfig)
