import 'server-only'

import { z } from 'zod'

import { env } from '@/shared/config/env'

// GitHub 릴리즈에서 데스크톱 설치파일 메타를 읽는다 — 서버 전용(토큰은 절대 클라이언트로 안 나감).
// 리포는 private 유지: 브라우저는 GitHub 를 직접 치지 않고, 실제 다운로드는 /api/desktop/download 가
// 세션 검사 후 GitHub 의 서명된 임시 URL 로 302 시켜준다. 설계: docs/architecture/desktop-app.md (D7 후속).

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

// 파일명 규약(electron-builder artifactName): Everdict-<ver>-<os>-<arch>.<ext> — blockmap/yml 은 제외된다.
const ASSET_NAME_RE = /-(linux|mac|win)-([A-Za-z0-9_]+)\.(AppImage|deb|dmg|zip|exe)$/

function classifyAsset(asset: z.infer<typeof githubAssetSchema>): DesktopAsset | null {
  const m = ASSET_NAME_RE.exec(asset.name)
  if (!m) return null
  const [, os, arch, ext] = m
  if (!os || !arch || !ext) return null
  return { id: asset.id, name: asset.name, size: asset.size, os: os as DesktopOs, arch, ext }
}

// 최신 desktop-v* 릴리즈의 설치파일 목록. 토큰 미설정/조회 실패/릴리즈 없음 → null(페이지가 폴백 안내).
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
        next: { revalidate: 300 }, // 릴리즈 메타는 5분 캐시 — 다운로드 자체는 라우트에서 no-store
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
    return null // 네트워크/스키마 오류 — 다운로드 페이지가 폴백을 보여준다
  }
}

// 다운로드 라우트용 — 우리 데스크톱 릴리즈에 속한 에셋만 허용(임의 asset id 프록시 방지).
export async function findDesktopAsset(id: number): Promise<DesktopAsset | null> {
  const release = await fetchDesktopRelease()
  return release?.assets.find((a) => a.id === id) ?? null
}
