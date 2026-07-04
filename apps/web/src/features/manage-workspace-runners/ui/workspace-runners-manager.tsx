'use client'

import { useEffect, useState, useTransition } from 'react'
import { Check, Copy, Server, Trash2 } from 'lucide-react'

import { capabilityMeta, type RunnerCapability, type RunnerMeta } from '@/entities/runner'
import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label } from '@/shared/ui/input'

import {
  pairWorkspaceRunnerAction,
  revokeWorkspaceRunnerAction,
} from '../api/manage-workspace-runners'

// 온라인 판정 — 러너는 long-poll lease(~25s)마다 lastSeenAt 을 갱신하므로 90s 안이면 접속 중으로 본다.
const ONLINE_WINDOW_MS = 90_000
function isOnline(lastSeenAt?: string): boolean {
  return lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS
}

// 워크스페이스-공유 러너(팀 자원) — admin 이 headless 러너(팀 빌드서버/CI)를 등록하면 이 워크스페이스 멤버
// 누구나 self:ws:<id> 로 타깃한다. 개인 러너(계정 페이지, 원클릭 데스크톱)와 달리 토큰을 1회 노출하고
// 서버에서 `assay runner --pair` 로 붙인다. 등록/해제는 admin(settings:write) — 컨트롤플레인이 강제.
export function WorkspaceRunnersManager({
  runners,
  canWrite,
}: {
  runners: RunnerMeta[]
  canWrite: boolean
}) {
  const [registerOpen, setRegisterOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onRevoke(id: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await revokeWorkspaceRunnerAction(id)
      setConfirmId(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-[13px] font-[560] text-foreground">공유 러너</h3>
          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            팀이 함께 쓰는 러너예요(빌드 서버·CI). 등록하면 이 워크스페이스 멤버 누구나 런타임을{' '}
            <span className="font-mono">self:ws:&lt;id&gt;</span> 로 지정해 실행할 수 있어요. 등록
            토큰은 한 번만 보여요.
          </p>
        </div>
        {canWrite && (
          <Button size="sm" className="shrink-0" onClick={() => setRegisterOpen(true)}>
            <Server />새 공유 러너 등록
          </Button>
        )}
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {runners.length === 0 ? (
        <EmptyState
          icon={<Server strokeWidth={1.75} />}
          title="아직 등록된 공유 러너가 없어요."
          hint={
            canWrite
              ? '팀 빌드 서버나 CI 머신을 공유 러너로 등록해 함께 쓸 수 있어요.'
              : '공유 러너를 등록하려면 관리자 권한이 필요해요.'
          }
          action={
            canWrite ? (
              <Button size="sm" variant="secondary" onClick={() => setRegisterOpen(true)}>
                <Server />새 공유 러너 등록
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border bg-card shadow-raise">
          {runners.map((r) => {
            const online = isOnline(r.lastSeenAt)
            return (
              <li key={r.id} className="flex items-center gap-3 px-3.5 py-3">
                <span className="relative grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground">
                  <Server className="size-4" strokeWidth={1.75} />
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
                    <span
                      className={cn(
                        'text-[12px]',
                        online ? 'text-[var(--color-success)]' : 'text-faint'
                      )}
                    >
                      {online ? '온라인' : '오프라인'}
                    </span>
                    {r.os && <Badge tone="outline">{r.os}</Badge>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {capabilityMeta.map(({ name, label }) => {
                      const has = r.capabilities.includes(name)
                      return (
                        <Badge
                          key={name}
                          tone={has ? 'success' : 'outline'}
                          className={has ? undefined : 'opacity-55'}
                          title={has ? '이 러너가 지원' : '이 러너에서 불가'}
                        >
                          {has ? '✓ ' : ''}
                          {label}
                        </Badge>
                      )
                    })}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
                    <code className="font-mono text-muted-foreground">self:ws:{r.id}</code>
                    <span>·</span>
                    <span>등록 {new Date(r.pairedAt).toLocaleString('ko-KR')}</span>
                  </div>
                </div>
                {canWrite &&
                  (confirmId === r.id ? (
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
                      aria-label={`${r.label} 공유 러너 해제`}
                      onClick={() => setConfirmId(r.id)}
                    >
                      <Trash2 />
                    </Button>
                  ))}
              </li>
            )
          })}
        </ul>
      )}

      {!canWrite && runners.length > 0 && (
        <p className="text-[12px] text-muted-foreground">
          공유 러너를 등록하거나 해제하려면 관리자 권한이 필요해요.
        </p>
      )}

      {canWrite && (
        <RegisterRunnerDialog open={registerOpen} onClose={() => setRegisterOpen(false)} />
      )}
    </div>
  )
}

// 등록 모달 — 이름 + OS(선택) + capability 선택 후 등록. 등록되면 같은 모달이 토큰 1회 노출 + 접속 명령 단계로 전환.
function RegisterRunnerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [label, setLabel] = useState('')
  const [os, setOs] = useState('')
  const [caps, setCaps] = useState<RunnerCapability[]>([])
  const [issued, setIssued] = useState<{ token: string; apiUrl?: string }>()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setLabel('')
    setOs('')
    setCaps([])
    setIssued(undefined)
    setCopied(false)
    setError(undefined)
  }, [open])

  function toggleCap(name: RunnerCapability) {
    setCaps((prev) => (prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]))
  }

  function onRegister() {
    setError(undefined)
    if (label.trim().length === 0) {
      setError('러너 이름을 입력해주세요.')
      return
    }
    startTransition(async () => {
      const r = await pairWorkspaceRunnerAction({
        label: label.trim(),
        ...(os.trim().length > 0 ? { os: os.trim() } : {}),
        ...(caps.length > 0 ? { capabilities: caps } : {}),
      })
      if (r.ok && r.token) setIssued({ token: r.token, ...(r.apiUrl ? { apiUrl: r.apiUrl } : {}) })
      else setError(r.error ?? '등록에 실패했어요.')
    })
  }

  // 서버에서 붙일 때 실행할 명령 — apiUrl 이 있으면 넣어 보여준다(비밀 아님).
  const command = issued
    ? `assay runner --pair --token ${issued.token}${issued.apiUrl ? ` --api-url ${issued.apiUrl}` : ''}`
    : ''

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-[520px]"
      labelledBy="register-runner-title"
    >
      {issued ? (
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="register-runner-title" className="text-[15px] font-[560] text-foreground">
              공유 러너가 등록됐어요
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              러너로 쓸 머신에서 아래 명령을 실행해 붙이세요. 토큰은 다시 볼 수 없어요.
            </p>
          </header>
          <div className="px-5 py-4">
            <Callout
              tone="warning"
              hint="이 토큰은 다시 볼 수 없어요. 지금 복사해 안전하게 보관하세요."
            >
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 select-all break-all font-mono text-xs">
                  {command}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    void copyText(command).then((ok) => ok && setCopied(true))
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? '복사됨' : '복사'}
                </Button>
              </div>
            </Callout>
          </div>
          <footer className="flex justify-end border-t border-border px-5 py-3.5">
            <Button size="sm" onClick={onClose}>
              완료
            </Button>
          </footer>
        </>
      ) : (
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="register-runner-title" className="text-[15px] font-[560] text-foreground">
              새 공유 러너 등록
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              팀이 함께 쓸 헤드리스 러너(빌드 서버·CI)를 등록해요.
            </p>
          </header>
          <div className="space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="runner-label">이름</Label>
              <Input
                id="runner-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="예: acme-ci-runner"
                maxLength={80}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="runner-os">OS (선택)</Label>
              <Input
                id="runner-os"
                value={os}
                onChange={(e) => setOs(e.target.value)}
                placeholder="linux · darwin · win32"
                maxLength={40}
              />
            </div>
            <div className="space-y-1.5">
              <Label>지원 기능 (선택)</Label>
              <p className="text-[12px] text-muted-foreground">
                러너가 붙을 때 실제로 프로브해 다시 광고해요 — 여기 선택은 초기 라벨이에요.
              </p>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {capabilityMeta.map(({ name, label: capLabel }) => {
                  const on = caps.includes(name)
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleCap(name)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[12px] transition-colors',
                        on
                          ? 'border-primary/40 bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-elevated'
                      )}
                    >
                      {on ? '✓ ' : ''}
                      {capLabel}
                    </button>
                  )
                })}
              </div>
            </div>
            {error && (
              <Callout tone="danger" className="py-1.5">
                {error}
              </Callout>
            )}
          </div>
          <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
            <Button size="sm" variant="secondary" onClick={onClose} disabled={pending}>
              취소
            </Button>
            <Button size="sm" onClick={onRegister} disabled={pending}>
              {pending ? '등록 중…' : '등록'}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  )
}
