'use client'

import { useEffect, useState, useTransition } from 'react'
import { Check, Copy, Laptop, Plus, Trash2 } from 'lucide-react'

import {
  runnerCapabilities,
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
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label } from '@/shared/ui/input'

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

// 러너는 개인 소유(self-scoped by subject) — 역할 게이트 없음. 모든 유저가 자기 머신을 페어링/해제한다.
export function RunnersManager({ runners }: { runners: RunnerMeta[] }) {
  const [pairOpen, setPairOpen] = useState(false)
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
            내 머신을 셀프호스티드 러너로 페어링하면, 워크스페이스의 공유 하니스·데이터셋을
            <span className="font-[510]"> 런타임만 바꿔</span> 내 호스트에서(내 로그인·repo 로)
            돌리고 결과를 워크스페이스로 회신할 수 있습니다. 러너는 워크스페이스가 아닌 내 계정
            소유입니다. 페어링 토큰은 한 번만 표시됩니다.
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {bridge && !desktop?.paired && (
            <Button size="sm" onClick={onConnectThisDevice} disabled={pending}>
              <Laptop />
              {pending ? '연결 중…' : '이 기기를 러너로 연결'}
            </Button>
          )}
          <Button
            size="sm"
            variant={bridge && !desktop?.paired ? 'secondary' : undefined}
            onClick={() => setPairOpen(true)}
          >
            <Plus />
            디바이스 페어링
          </Button>
        </span>
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {runners.length === 0 ? (
        <EmptyState
          icon={<Laptop strokeWidth={1.75} />}
          title="아직 페어링된 러너가 없습니다."
          hint={
            bridge
              ? '버튼 한 번으로 이 기기를 러너로 연결할 수 있습니다.'
              : '내 머신을 페어링해 워크스페이스의 평가를 내 호스트에서 실행하세요.'
          }
          action={
            bridge ? (
              <Button size="sm" onClick={onConnectThisDevice} disabled={pending}>
                <Laptop />
                {pending ? '연결 중…' : '이 기기를 러너로 연결'}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setPairOpen(true)}>
                <Plus />
                디바이스 페어링
              </Button>
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

      <PairRunnerDialog open={pairOpen} onClose={() => setPairOpen(false)} />
    </div>
  )
}

// 페어링 모달 — 디바이스 이름 + OS + capability 선택 후 페어링. 페어되면 같은 모달이 토큰 1회 노출 단계로 전환.
function PairRunnerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [label, setLabel] = useState('')
  const [os, setOs] = useState('')
  const [caps, setCaps] = useState<RunnerCapability[]>([])
  const [token, setToken] = useState<string>() // 방금 페어된 평문 토큰(1회 노출)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  // 열릴 때마다 폼 초기화(이전 페어/입력 잔상 제거).
  useEffect(() => {
    if (!open) return
    setLabel('')
    setOs('')
    setCaps([])
    setToken(undefined)
    setCopied(false)
    setError(undefined)
  }, [open])

  function toggleCap(c: RunnerCapability) {
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
  }

  function onPair() {
    setError(undefined)
    if (!label.trim()) {
      setError('디바이스 이름을 입력하세요.')
      return
    }
    startTransition(async () => {
      const r = await pairRunnerAction({
        label: label.trim(),
        ...(os.trim() ? { os: os.trim() } : {}),
        ...(caps.length > 0 ? { capabilities: caps } : {}),
      })
      if (r.ok) setToken(r.token)
      else setError(r.error)
    })
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-[460px]" labelledBy="pair-runner-title">
      {token ? (
        // 2단계 — 페어링 완료(토큰 1회 노출)
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="pair-runner-title" className="text-[15px] font-[560] text-foreground">
              디바이스가 페어링되었습니다
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              아래 토큰을 지금 복사해 안전한 곳에 보관하세요.
            </p>
          </header>
          <div className="space-y-3 px-5 py-4">
            <Callout
              tone="warning"
              hint="이 값은 다시 표시되지 않습니다. 러너 클라이언트(assay runner)가 이 토큰으로 인증합니다."
            >
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 select-all break-all font-mono text-xs">
                  {token}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    void navigator.clipboard?.writeText(token)
                    setCopied(true)
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? '복사됨' : '복사'}
                </Button>
              </div>
            </Callout>
            <p className="text-[12px] leading-relaxed text-faint">
              내 머신에서 <code className="font-mono">assay runner --pair &lt;token&gt;</code> 으로
              연결합니다. 데스크톱 앱에서는 이 과정 없이 &lsquo;이 기기를 러너로 연결&rsquo; 버튼 한
              번으로 끝납니다. 페어링 후 실행 폼의 런타임 선택에 이 러너가 나타납니다.
            </p>
          </div>
          <footer className="flex justify-end border-t border-border px-5 py-3.5">
            <Button size="sm" onClick={onClose}>
              완료
            </Button>
          </footer>
        </>
      ) : (
        // 1단계 — 디바이스 이름 + OS + capability
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="pair-runner-title" className="text-[15px] font-[560] text-foreground">
              디바이스 페어링
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              이 머신을 식별할 이름과, 이 머신이 돌릴 수 있는 환경을 선택하세요.
            </p>
          </header>

          <div className="space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="runner-label">디바이스 이름</Label>
              <Input
                id="runner-label"
                value={label}
                placeholder="ho-macbook, ci-linux-01 …"
                autoFocus
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="runner-os">OS (선택)</Label>
              <Input
                id="runner-os"
                value={os}
                placeholder="darwin · linux · win32"
                onChange={(e) => setOs(e.target.value)}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label>실행 가능 환경 (Capabilities)</Label>
              <div className="flex flex-wrap gap-2">
                {runnerCapabilities.map((c) => (
                  <label
                    key={c}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px] hover:border-border-strong"
                  >
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={caps.includes(c)}
                      onChange={() => toggleCap(c)}
                    />
                    <span className="text-foreground">{CAP_LABEL[c] ?? c}</span>
                  </label>
                ))}
              </div>
            </div>

            {error && (
              <Callout tone="danger" className="py-1.5">
                {error}
              </Callout>
            )}
          </div>

          <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
            <Button variant="ghost" size="sm" onClick={onClose}>
              취소
            </Button>
            <Button size="sm" onClick={onPair} disabled={pending}>
              {pending ? '페어링 중…' : '페어링'}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  )
}
