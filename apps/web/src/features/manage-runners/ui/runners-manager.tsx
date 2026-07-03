'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { Download, Laptop, Trash2 } from 'lucide-react'

import { runnerCapabilitySchema, type RunnerCapability, type RunnerMeta } from '@/entities/runner'
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

// capability id → 표시 라벨.
const CAP_LABEL: Record<string, string> = {
  repo: 'Repo',
  browser: 'Browser',
  'os-use': 'OS-use',
  docker: 'Docker',
}

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
          setError(r.error ?? '페어링에 실패했습니다.')
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
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-[13px] font-[560] text-foreground">연결된 러너</h3>
          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            내 머신을 셀프호스티드 러너로 연결하면, 워크스페이스의 공유 하니스·데이터셋을
            <span className="font-[510]"> 런타임만 바꿔</span> 내 호스트에서(내 로그인·repo 로)
            돌리고 결과를 워크스페이스로 회신할 수 있습니다. 러너는 워크스페이스가 아닌 내 계정
            소유입니다.{' '}
            {bridge
              ? '연결은 버튼 한 번이면 됩니다.'
              : '연결은 데스크톱 앱에서 버튼 한 번으로 이루어집니다 — 브라우저에서는 러너를 관리(상태 확인·해제)만 합니다.'}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {/* 페어링 표면은 데스크톱 전담(D7) — 브라우저에는 다운로드 CTA 만 노출. */}
          {bridge && !desktop?.paired && (
            <Button size="sm" onClick={onConnectThisDevice} disabled={pending}>
              <Laptop />
              {pending ? '연결 중…' : '이 기기를 러너로 연결'}
            </Button>
          )}
          {!bridge && (
            <Link href={downloadHref} className={buttonVariants({ size: 'sm' })}>
              <Download />
              데스크톱 앱 받기
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
              <span>
                이 기기는 다른 계정(또는 이미 해제된 페어링)으로 연결되어 있습니다. 다시 연결하면 이
                계정의 러너로 대체됩니다.
              </span>
              <Button
                size="xs"
                variant="secondary"
                onClick={onConnectThisDevice}
                disabled={pending}
              >
                <Laptop />
                {pending ? '연결 중…' : '이 계정으로 다시 연결'}
              </Button>
            </span>
          </Callout>
        )}

      {runners.length === 0 ? (
        <EmptyState
          icon={<Laptop strokeWidth={1.75} />}
          title="아직 연결된 러너가 없습니다."
          hint={
            bridge
              ? '버튼 한 번으로 이 기기를 러너로 연결할 수 있습니다.'
              : '데스크톱 앱을 설치하면 버튼 한 번으로 이 기기를 러너로 연결할 수 있습니다.'
          }
          action={
            bridge ? (
              <Button size="sm" onClick={onConnectThisDevice} disabled={pending}>
                <Laptop />
                {pending ? '연결 중…' : '이 기기를 러너로 연결'}
              </Button>
            ) : (
              <Link
                href={downloadHref}
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              >
                <Download />
                데스크톱 앱 받기
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
                ? `실행 중 (${desktop.activeJobs})`
                : desktop.state === 'idle'
                  ? '온라인'
                  : '오프라인'
              : online
                ? '온라인'
                : '오프라인'
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
                    title={online ? '온라인' : '오프라인'}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-[510] text-foreground">
                      {r.label}
                    </span>
                    {thisDevice && <Badge>이 기기</Badge>}
                    <span
                      className={cn(
                        'text-[12px]',
                        online ? 'text-[var(--color-success)]' : 'text-faint'
                      )}
                    >
                      {statusText}
                    </span>
                    {r.os && <Badge tone="outline">{r.os}</Badge>}
                    {caps.map((c) => (
                      <Badge key={c} tone="outline">
                        {CAP_LABEL[c] ?? c}
                      </Badge>
                    ))}
                    {thisDevice && online && !caps.includes('docker') && (
                      <span className="text-[12px] text-faint">
                        docker 없음 → service 하니스 불가
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
                    <span>페어링 {new Date(r.pairedAt).toLocaleString('ko-KR')}</span>
                    {r.lastSeenAt && (
                      <>
                        <span>·</span>
                        <span>최근 접속 {new Date(r.lastSeenAt).toLocaleString('ko-KR')}</span>
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
                      해제 확인
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => setConfirmId(undefined)}
                    >
                      닫기
                    </button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`${r.label} 러너 해제`}
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
