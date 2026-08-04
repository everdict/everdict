import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

// A relative import, not the `@/` alias: this module is read while Next is still booting its config.
import { DETAIL_ROUTES } from './src/shared/lib/resource-routes'

// i18n request config (cookie-based locale — no URL routing). Catalogs are messages/{ko,en}.json.
const withNextIntl = createNextIntlPlugin('./src/shared/i18n/request.ts')

// The addresses that moved when detail routes went singular — `/{ws}/scorecards/{id}` → `/{ws}/scorecard/{id}`.
// A COLLECTION keeps its plural (`/{ws}/scorecards` is still the list), so only an address with something after
// the collection segment moves, and only when that something is an id rather than one of the collection's own
// named screens. Those names come from the shared table and are excluded by a lookahead: without it,
// `/scorecards/new` would redirect to `/scorecard/new`, which is nothing.
//
// The table is shared with the sidebar and the team path reader (`src/shared/lib/resource-routes.ts`) — three
// places have to agree on the pairing, and each deriving it separately is what left detail pages lighting no
// nav row. `teams` is filtered out here because one team owns a whole subtree and gets its own rule below.
const DETAIL_MOVES = DETAIL_ROUTES.filter((route) => route.plural !== 'teams')

// Not permanent (307, not 308) on purpose: a browser caches a permanent redirect hard enough that reverting the
// scheme would strand anyone who had followed one. Promote these to `permanent: true` once the singular
// addresses have been confirmed live.
async function movedDetailRoutes() {
  return [
    // A team's cycle is addressed by its number under the team — more specific than the generic team rule
    // below, so it has to be matched first. Digits only, because `…/cycles/all` is the index and stays put.
    {
      source: '/:workspace/teams/:key/cycles/:number(\\d+)',
      destination: '/:workspace/team/:key/cycle/:number',
      permanent: false,
    },
    // The same address after the team segment was already singularised, for a link built in between.
    {
      source: '/:workspace/team/:key/cycles/:number(\\d+)',
      destination: '/:workspace/team/:key/cycle/:number',
      permanent: false,
    },
    // One team and everything under it. `/teams` alone is the directory of teams and keeps its plural, which is
    // why `:key` is required rather than optional.
    {
      source: '/:workspace/teams/:key/:rest*',
      destination: '/:workspace/team/:key/:rest*',
      permanent: false,
    },
    ...DETAIL_MOVES.map(({ plural, singular, reserved }) => {
      const guard = reserved.length === 0 ? '' : `(?!(?:${reserved.join('|')})$)`
      return {
        source: `/:workspace/${plural}/:id(${guard}[^/]+)/:rest*`,
        destination: `/:workspace/${singular}/:id/:rest*`,
        permanent: false,
      }
    }),
  ]
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  redirects: movedDetailRoutes,
  // undici 는 번들하지 않고 런타임에 node_modules 에서 require — instrumentation 의 setGlobalDispatcher 가
  // Node 내장 fetch 가 읽는 전역 심볼(Symbol.for 레지스트리)과 동일 인스턴스 의미론으로 동작하게 한다(프록시 지원).
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
