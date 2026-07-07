'use client'

import { useEffect, useState } from 'react'
import { Download, ExternalLink, Laptop } from 'lucide-react'
import { useTranslations } from 'next-intl'

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
function assetLabel(a: DesktopAsset, t: ReturnType<typeof useTranslations>): string {
  if (a.ext === 'AppImage') return 'Linux AppImage (x86_64)'
  if (a.ext === 'deb') return 'Ubuntu/Debian .deb (amd64)'
  if (a.ext === 'exe') return t('winInstaller')
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
  const t = useTranslations('downloadDesktop')
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
        title={t('loadFailedTitle')}
        hint={t('loadFailedHint')}
        action={
          <a
            href={fallbackUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ size: 'sm' })}
          >
            <ExternalLink />
            {t('openReleasePage')}
          </a>
        }
      />
    ) : (
      <EmptyState
        icon={<Download strokeWidth={1.75} />}
        title={t('preparingTitle')}
        hint={t('preparingHint')}
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
      {inDesktop && <Callout tone="info">{t('inDesktopNote')}</Callout>}

      {/* 감지된 OS 의 권장 다운로드 */}
      {os && recommended.length > 0 && (
        <section className="space-y-2.5">
          <h3 className="text-[13px] font-[560] text-foreground">
            {t('recommendedFor', { os: OS_LABEL[os] })}{' '}
            <Badge tone="outline">v{release.version}</Badge>
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
                {assetLabel(a, t)}
              </a>
            ))}
          </div>
          {os === 'mac' && <p className="text-[12px] text-faint">{t('macNote')}</p>}
        </section>
      )}

      {/* 전체 플랫폼 목록 */}
      <section className="space-y-2.5">
        <h3 className="text-[13px] font-[560] text-foreground">{t('allPlatforms')}</h3>
        <ul className="divide-y divide-border rounded-lg border bg-card shadow-raise">
          {release.assets.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <Laptop className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <span className="text-[13px] font-[510] text-foreground">{assetLabel(a, t)}</span>
                <span className="ml-2 text-[12px] text-faint">
                  {a.name} · {formatSize(a.size)}
                </span>
              </div>
              <a
                href={downloadHref(a)}
                className={buttonVariants({ size: 'xs', variant: 'secondary' })}
              >
                <Download />
                {t('download')}
              </a>
            </li>
          ))}
        </ul>
      </section>

      {/* 설치 후 안내 + unsigned 주의 */}
      <section className="space-y-2.5">
        <h3 className="text-[13px] font-[560] text-foreground">{t('afterInstall')}</h3>
        <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
          <li>{t('step1')}</li>
          <li>
            {t.rich('step2', { b: (chunks) => <span className="font-[510]">{chunks}</span> })}
          </li>
          <li>{t('step3')}</li>
        </ol>
        <Callout tone="warning" className="text-[13px]">
          {t.rich('unsignedWarning', {
            code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
          })}
        </Callout>
      </section>
    </div>
  )
}
