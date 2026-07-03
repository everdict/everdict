'use client'

import { useEffect, useState } from 'react'
import { Download, ExternalLink, Laptop } from 'lucide-react'

import { getAssayDesktop } from '@/shared/lib/desktop-bridge'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'

import type { DesktopAsset, DesktopOs, DesktopRelease } from '../api/releases'

const OS_LABEL: Record<DesktopOs, string> = { linux: 'Linux', mac: 'macOS', win: 'Windows' }

// 브라우저 UA → 권장 OS. arm/x64 구분은 UA 로 신뢰할 수 없어(특히 Apple Silicon) OS 까지만 감지한다.
function detectOs(): DesktopOs | null {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'win'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return null
}

function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

// 사람이 고르기 쉬운 라벨 — 파일 확장자/arch 를 풀어서 쓴다.
function assetLabel(a: DesktopAsset): string {
  if (a.ext === 'AppImage') return 'Linux AppImage (x86_64)'
  if (a.ext === 'deb') return 'Ubuntu/Debian .deb (amd64)'
  if (a.ext === 'exe') return 'Windows 설치 파일 (x64)'
  const macArch = a.arch === 'arm64' ? 'Apple Silicon (arm64)' : 'Intel (x64)'
  return a.ext === 'dmg' ? `macOS .dmg — ${macArch}` : `macOS .zip — ${macArch}`
}

// OS 별 권장 순서 — 감지된 OS 섹션의 버튼 정렬(리스트에도 같은 순서).
const RECOMMEND_ORDER: Record<DesktopOs, (a: DesktopAsset) => number> = {
  linux: (a) => (a.ext === 'AppImage' ? 0 : 1),
  mac: (a) => (a.ext === 'dmg' ? (a.arch === 'arm64' ? 0 : 1) : 2),
  win: () => 0,
}

function downloadHref(a: DesktopAsset): string {
  return `/api/desktop/download?id=${a.id}`
}

export function DownloadPanel({
  release,
  fallbackUrl,
}: {
  release: DesktopRelease | null
  fallbackUrl?: string // DESKTOP_DOWNLOAD_URL — 릴리즈 토큰 미설정 환경의 외부 링크 폴백
}) {
  const [os, setOs] = useState<DesktopOs | null>(null)
  const [inDesktop, setInDesktop] = useState(false)

  useEffect(() => {
    setOs(detectOs())
    setInDesktop(getAssayDesktop() !== null)
  }, [])

  if (release === null) {
    return fallbackUrl ? (
      <EmptyState
        icon={<Download strokeWidth={1.75} />}
        title="릴리즈 목록을 불러올 수 없습니다."
        hint="서버에 릴리즈 토큰(DESKTOP_RELEASES_TOKEN)이 설정되지 않았거나 조회에 실패했습니다. 외부 릴리즈 페이지에서 받아주세요."
        action={
          <a
            href={fallbackUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ size: 'sm' })}
          >
            <ExternalLink />
            릴리즈 페이지 열기
          </a>
        }
      />
    ) : (
      <EmptyState
        icon={<Download strokeWidth={1.75} />}
        title="다운로드를 준비 중입니다."
        hint="관리자가 서버에 DESKTOP_RELEASES_TOKEN(GitHub fine-grained PAT, contents:read)을 설정하면 이 페이지에서 바로 받을 수 있습니다."
      />
    )
  }

  const recommended = os
    ? release.assets
        .filter((a) => a.os === os)
        .sort((a, b) => RECOMMEND_ORDER[os](a) - RECOMMEND_ORDER[os](b))
    : []

  return (
    <div className="space-y-6">
      {inDesktop && (
        <Callout tone="info">
          이미 데스크톱 앱에서 보고 계십니다 — 계정 &gt; 연결된 러너에서 바로 이 기기를 연결하세요.
        </Callout>
      )}

      {/* 감지된 OS 의 권장 다운로드 */}
      {os && recommended.length > 0 && (
        <section className="space-y-2.5">
          <h3 className="text-[13px] font-[560] text-foreground">
            내 컴퓨터용 다운로드 — {OS_LABEL[os]} <Badge tone="outline">v{release.version}</Badge>
          </h3>
          <div className="flex flex-wrap gap-2">
            {recommended.map((a, i) => (
              <a
                key={a.id}
                href={downloadHref(a)}
                className={buttonVariants({
                  size: 'sm',
                  ...(i > 0 ? { variant: 'secondary' } : {}),
                })}
              >
                <Download />
                {assetLabel(a)}
              </a>
            ))}
          </div>
          {os === 'mac' && (
            <p className="text-[12px] text-faint">
              애플 실리콘(M1 이후)은 arm64, 인텔 맥은 x64 를 받으세요.
            </p>
          )}
        </section>
      )}

      {/* 전체 플랫폼 목록 */}
      <section className="space-y-2.5">
        <h3 className="text-[13px] font-[560] text-foreground">모든 플랫폼</h3>
        <ul className="divide-y divide-border rounded-lg border bg-card shadow-raise">
          {release.assets.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <Laptop className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <span className="text-[13px] font-[510] text-foreground">{assetLabel(a)}</span>
                <span className="ml-2 text-[12px] text-faint">
                  {a.name} · {formatSize(a.size)}
                </span>
              </div>
              <a
                href={downloadHref(a)}
                className={buttonVariants({ size: 'xs', variant: 'secondary' })}
              >
                <Download />
                받기
              </a>
            </li>
          ))}
        </ul>
      </section>

      {/* 설치 후 안내 + unsigned 주의 */}
      <section className="space-y-2.5">
        <h3 className="text-[13px] font-[560] text-foreground">설치 후</h3>
        <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
          <li>앱을 실행하고 웹과 같은 계정으로 로그인합니다.</li>
          <li>
            계정 &gt; <span className="font-[510]">연결된 러너</span>에서{' '}
            <span className="font-[510]">이 기기를 러너로 연결</span> 버튼 한 번 — 끝입니다.
          </li>
          <li>스코어카드 실행 폼의 런타임 선택에 내 기기가 나타납니다.</li>
        </ol>
        <Callout tone="warning" className="text-[13px]">
          설치 파일은 아직 서명되지 않았습니다 — macOS 는 우클릭 → 열기(게이트키퍼), Windows 는
          SmartScreen 의 &lsquo;추가 정보 → 실행&rsquo;, Linux AppImage 는{' '}
          <code className="font-mono text-xs">chmod +x</code> 후 실행하세요.
        </Callout>
      </section>
    </div>
  )
}
