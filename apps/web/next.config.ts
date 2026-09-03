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

// 첫 세그먼트가 워크스페이스인 주소만 이 규칙들의 대상이다 — `api` 같은 예약어는 워크스페이스가 아니다
// (`RESERVED_TOP_LEVEL`, 미들웨어가 읽는 그 목록). 가드가 없으면 우리 BFF 라우트가 통째로 걸린다:
// `/api/issues/:id/attachment` 가 `/api/issue/:id/attachment`(없는 주소)로 307 되어, 이슈 본문의 GitHub
// 첨부 이미지와 런 녹화 다운로드가 조용히 죽는다 — 라우트는 멀쩡한데 요청이 도달하지 못한다.
// ⚠️ 세그먼트의 끝은 `$` 가 아니라 `(?:/|$)` 다: path-to-regexp 가 만든 정규식에서 `$` 는 **경로 전체**의
// 끝을 뜻하므로, 뒤에 무언가 더 붙는 첫 세그먼트에는 영원히 걸리지 않는다(가드가 통째로 무력해진다).
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
