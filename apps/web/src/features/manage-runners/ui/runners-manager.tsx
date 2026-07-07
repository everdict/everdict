'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { Download, Laptop, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import {
  capabilityMeta,
  runnerCapabilitySchema,
  type RunnerCapability,
  type RunnerMeta,
} from '@/entities/runner'
import {
  getAssayDesktop,
  type AssayDesktopBridge,
  type DesktopRunnerStatus,
} from '@/shared/lib/desktop-bridge'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'

import { pairRunnerAction, revokeRunnerAction } from '../api/manage-runners'

// 온라인 판정 — 러너는 long-poll lease(~25s)마다 lastSeenAt 을 갱신하므로 90s 안이면 접속 중으로 본다.
// (페이지 로드 시점 기준 — 실시간 갱신은 아님.)
const ONLINE_WINDOW_MS = 90_000
function isOnline(lastSeenAt?: string): boolean {
  return lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS
}

function isRunnerCapability(value: string): value is RunnerCapability {
  return runnerCapabilitySchema.safeParse(value).success
}

// 러너는 개인 소유(self-scoped by subject) — 역할 게이트 없음.
// 페어링 표면은 데스크톱 앱이 전담한다(원클릭; 설계 D7): 브라우저에서는 수동 페어링(토큰 1회 노출)을
// 제공하지 않고 목록/라이브 상태/해제만 — 대신 데스크톱 다운로드를 제안한다. headless 서버는 API 키로
// `POST /runners` → `assay runner --pair` (docs/architecture/self-hosted-runner.md).
export function RunnersManager({
  runners,
  downloadHref,
}: {
  runners: RunnerMeta[]
  downloadHref: string // /{workspace}/download — 브라우저 사용자용 데스크톱 다운로드 페이지
}) {
  const t = useTranslations('manageRunners')
  const locale = useLocale()
  const [confirmId, setConfirmId] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()
  // 데스크톱 셸 감지 — 브리지가 있으면 원클릭 페어링 + 이 기기 라이브 상태(마운트 후에만; SSR 불일치 방지).
  const [bridge, setBridge] = useState<AssayDesktopBridge | null>(null)
  const [desktop, setDesktop] = useState<DesktopRunnerStatus | null>(null)

  useEffect(() => {
    const b = getAssayDesktop()
    if (!b) return
    setBridge(b)
    void b
      .runnerStatus()
      .then(setDesktop)
      .catch(() => {})
    return b.onRunnerStatus(setDesktop)
  }, [])

  function onRevoke(id: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await revokeRunnerAction(id)
      setConfirmId(undefined)
      if (!r.ok) {
        setError(r.error)
        return
      }
      // 이 기기를 해제했다면 데스크톱 쪽 토큰/러너도 정리(서버 revoke 가 권위 — 브리지 실패는 무시).
      if (bridge && desktop?.runnerId === id) await bridge.unpairRunner().catch(() => {})
    })
  }

  // 원클릭 — appInfo(호스트명/OS/capability)로 페어링하고, 토큰은 화면에 노출하지 않고 브리지로만 내려보낸다.
  function onConnectThisDevice() {
    const b = bridge
    if (!b) return
    setError(undefined)
    startTransition(async () => {
      try {
        const info = await b.appInfo()
        const caps = info.capabilities.filter(isRunnerCapability)
        const r = await pairRunnerAction({
          label: info.hostname,
          os: info.platform,
          ...(caps.length > 0 ? { capabilities: caps } : {}),
        })
        if (!r.ok || !r.token) {
          setError(r.error ?? t('connectFailed'))
          return
        }
        await b.pairRunner({
          token: r.token,
          ...(r.runner ? { runnerId: r.runner.id } : {}),
          ...(r.apiUrl ? { apiUrl: r.apiUrl } : {}),
        })
        setDesktop(await b.runnerStatus())
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[13px] text-muted-foreground">{t('ownedByYou')}</p>
        <span className="flex shrink-0 items-center gap-2">
          {/* 페어링 표면은 데스크톱 전담(D7) — 브라우저에는 다운로드 CTA 만 노출. */}
          {bridge && !desktop?.paired && (
            <Button size="sm" onClick={onConnectThisDevice} disabled={pending}>
              <Laptop />
              {pending ? t('connecting') : t('connectThisDevice')}
            </Button>
          )}
          {!bridge && (
            <Link href={downloadHref} className={buttonVariants({ size: 'sm' })}>
              <Download />
              {t('getDesktopApp')}
            </Link>
          )}
        </span>
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {/* 계정 전환/해제 불일치: 이 데스크톱이 내 목록에 없는 러너로 페어돼 있다 — 다른 계정의 페어링이거나
          서버에서 해제된 페어링. 재연결로 로컬 페어링을 이 계정 소유의 새 러너로 대체한다. */}
      {bridge &&
        desktop?.paired === true &&
        desktop.runnerId !== undefined &&
        !runners.some((r) => r.id === desktop.runnerId) && (
          <Callout tone="warning">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>{t('otherAccountWarning')}</span>
              <Button
                size="xs"
                variant="secondary"
                onClick={onConnectThisDevice}
                disabled={pending}
              >
                <Laptop />
                {pending ? t('connecting') : t('reconnectThisAccount')}
              </Button>
            </span>
          </Callout>
        )}

      {runners.length === 0 ? (
        <EmptyState
          icon={<Laptop strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={bridge ? t('emptyHintBridge') : t('emptyHintDownload')}
          action={
            bridge ? (
              <Button size="sm" onClick={onConnectThisDevice} disabled={pending}>
                <Laptop />
                {pending ? t('connecting') : t('connectThisDevice')}
              </Button>
            ) : (
              <Link
                href={downloadHref}
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              >
                <Download />
                {t('getDesktopApp')}
              </Link>
            )
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border bg-card shadow-raise">
          {runners.map((r) => {
            // 이 기기(데스크톱 셸에 페어된 러너)는 lastSeenAt 추정 대신 브리지의 라이브 상태를 쓴다.
            const thisDevice = desktop?.paired === true && desktop.runnerId === r.id
            const online = thisDevice ? desktop.state !== 'off' : isOnline(r.lastSeenAt)
            // capability 도 라이브 우선 — 페어 후 docker 데몬이 꺼졌다면 즉시 반영된다.
            const caps =
              thisDevice && desktop.capabilities.length > 0 ? desktop.capabilities : r.capabilities
            const statusText = thisDevice
              ? desktop.state === 'running'
                ? t('running', { count: desktop.activeJobs })
                : desktop.state === 'idle'
                  ? t('online')
                  : t('offline')
              : online
                ? t('online')
                : t('offline')
            return (
              <li key={r.id} className="flex items-center gap-3 px-3.5 py-3">
                <span className="relative grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground">
                  <Laptop className="size-4" strokeWidth={1.75} />
                  {/* 접속 상태 점 — 우하단 */}
                  <span
                    className={cn(
                      'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card',
                      online ? 'bg-[var(--color-success)]' : 'bg-muted-foreground/40'
                    )}
                    title={online ? t('online') : t('offline')}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-[510] text-foreground">
                      {r.label}
                    </span>
                    {thisDevice && <Badge>{t('thisDevice')}</Badge>}
                    <span
                      className={cn(
                        'text-[12px]',
                        online ? 'text-[var(--color-success)]' : 'text-faint'
                      )}
                    >
                      {statusText}
                    </span>
                    {r.os && <Badge tone="outline">{r.os}</Badge>}
                  </div>
                  {/* capability 자가-라벨 — green(가능)/grey(불가). 러너가 자기 머신을 프로브해 광고한다. */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {capabilityMeta.map(({ name, label }) => {
                      const has = caps.includes(name)
                      return (
                        <Badge
                          key={name}
                          tone={has ? 'success' : 'outline'}
                          className={has ? undefined : 'opacity-55'}
                          title={has ? t('capSupported') : t('capUnsupported')}
                        >
                          {has ? '✓ ' : ''}
                          {label}
                        </Badge>
                      )
                    })}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
                    <span>
                      {t('pairedAt', { date: new Date(r.pairedAt).toLocaleString(locale) })}
                    </span>
                    {r.lastSeenAt && (
                      <>
                        <span>·</span>
                        <span>
                          {t('lastSeenAt', {
                            date: new Date(r.lastSeenAt).toLocaleString(locale),
                          })}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {confirmId === r.id ? (
                  <span className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="destructive"
                      size="xs"
                      disabled={pending}
                      onClick={() => onRevoke(r.id)}
                    >
                      {t('revokeConfirm')}
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => setConfirmId(undefined)}
                    >
                      {t('close')}
                    </button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('revokeRunnerAria', { name: r.label })}
                    onClick={() => setConfirmId(r.id)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
