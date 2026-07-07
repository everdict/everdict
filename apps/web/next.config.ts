import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'

// i18n request config (cookie-based locale — no URL routing). Catalogs are messages/{ko,en}.json.
const withNextIntl = createNextIntlPlugin('./src/shared/i18n/request.ts')

const nextConfig: NextConfig = {
  // Only uses the control-plane (@everdict/api) HTTP client, so no extra server packages.
  reactStrictMode: true,
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
