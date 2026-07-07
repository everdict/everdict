'use client'

import { useEffect, useState } from 'react'
import { Download, ExternalLink, Laptop } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { getEverdictDesktop } from '@/shared/lib/desktop-bridge'
import { Badge } from '@/shared/ui/badge'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'

import type { DesktopAsset, DesktopOs, DesktopRelease } from '../api/releases'

const OS_LABEL: Record<DesktopOs, string> = { linux: 'Linux', mac: 'macOS', win: 'Windows' }

// Browser UA → recommended OS. The arm/x64 distinction can't be trusted from the UA (especially Apple Silicon), so detect only down to the OS.
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

// A label that's easy for a human to pick — spells out the file extension/arch.
function assetLabel(a: DesktopAsset, t: ReturnType<typeof useTranslations>): string {
  if (a.ext === 'AppImage') return 'Linux AppImage (x86_64)'
  if (a.ext === 'deb') return 'Ubuntu/Debian .deb (amd64)'
  if (a.ext === 'exe') return t('winInstaller')
  const macArch = a.arch === 'arm64' ? 'Apple Silicon (arm64)' : 'Intel (x64)'
  return a.ext === 'dmg' ? `macOS .dmg — ${macArch}` : `macOS .zip — ${macArch}`
}

// Recommended order per OS — sorts the buttons in the detected-OS section (same order in the list too).
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
  fallbackUrl?: string // DESKTOP_DOWNLOAD_URL — external-link fallback for environments where the release token is unset
}) {
  const t = useTranslations('downloadDesktop')
  const [os, setOs] = useState<DesktopOs | null>(null)
  const [inDesktop, setInDesktop] = useState(false)

  useEffect(() => {
    setOs(detectOs())
    setInDesktop(getEverdictDesktop() !== null)
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

      {/* recommended download for the detected OS */}
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

      {/* full platform list */}
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

      {/* post-install guidance + unsigned caveat */}
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
