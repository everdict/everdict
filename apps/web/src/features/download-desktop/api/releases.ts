import 'server-only'

import { z } from 'zod'

import { env } from '@/shared/config/env'

// Reads desktop installer metadata from GitHub Releases — server-only (the token never reaches the client).
// The repo stays private: the browser never hits GitHub directly; the actual download is done by /api/desktop/download,
// which checks the session and then 302s to GitHub's signed temporary URL. Design: docs/architecture/desktop-app.md (D7 follow-up).

const githubAssetSchema = z.object({ id: z.number(), name: z.string(), size: z.number() })
const githubReleaseSchema = z.object({
  tag_name: z.string(),
  published_at: z.string().nullable(),
  assets: z.array(githubAssetSchema),
})

export type DesktopOs = 'linux' | 'mac' | 'win'

export interface DesktopAsset {
  id: number
  name: string
  size: number
  os: DesktopOs
  arch: string // x86_64 · amd64 · arm64 · x64
  ext: string // AppImage · deb · dmg · zip · exe
}

export interface DesktopRelease {
  version: string
  publishedAt?: string
  assets: DesktopAsset[]
}

// Filename convention (electron-builder artifactName): Everdict-<ver>-<os>-<arch>.<ext> — blockmap/yml are excluded.
const ASSET_NAME_RE = /-(linux|mac|win)-([A-Za-z0-9_]+)\.(AppImage|deb|dmg|zip|exe)$/

function classifyAsset(asset: z.infer<typeof githubAssetSchema>): DesktopAsset | null {
  const m = ASSET_NAME_RE.exec(asset.name)
  if (!m) return null
  const [, os, arch, ext] = m
  if (!os || !arch || !ext) return null
  return { id: asset.id, name: asset.name, size: asset.size, os: os as DesktopOs, arch, ext }
}

// Installer list for the latest desktop-v* release. Token unset / fetch failure / no release → null (the page shows a fallback).
export async function fetchDesktopRelease(): Promise<DesktopRelease | null> {
  const token = env.DESKTOP_RELEASES_TOKEN
  if (!token) return null
  try {
    const res = await fetch(
      `https://api.github.com/repos/${env.DESKTOP_RELEASES_REPO}/releases?per_page=20`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        next: { revalidate: 300 }, // release metadata is cached for 5 min — the download itself is no-store in the route
      }
    )
    if (!res.ok) return null
    const releases = z.array(githubReleaseSchema).parse(await res.json())
    const release = releases.find((r) => r.tag_name.startsWith('desktop-v'))
    if (!release) return null
    const assets = release.assets
      .map(classifyAsset)
      .filter((a): a is DesktopAsset => a !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
    if (assets.length === 0) return null
    return {
      version: release.tag_name.replace(/^desktop-v/, ''),
      ...(release.published_at ? { publishedAt: release.published_at } : {}),
      assets,
    }
  } catch {
    return null // network/schema error — the download page shows a fallback
  }
}

// For the download route — allow only assets belonging to our desktop release (prevents proxying an arbitrary asset id).
export async function findDesktopAsset(id: number): Promise<DesktopAsset | null> {
  const release = await fetchDesktopRelease()
  return release?.assets.find((a) => a.id === id) ?? null
}
