'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { Check, GitBranch, Lock, Search } from 'lucide-react'

import type { CiLink, RepoInfo } from '@/entities/ci-link'
import type { ConnectionMeta } from '@/entities/connection'
import type { HarnessKind } from '@/entities/harness'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'

import { listConnectionReposAction, upsertCiLinkAction } from '../api/manage-ci-links'
import { SetupPrButton } from './setup-pr-button'

interface SlotState {
  enabled: boolean
  path: string
}

// 슬롯 초기값 — command 는 image 를 기본 선택, 서비스 슬롯이 하나뿐이면 자동 선택, 여럿이면 사용자가 고른다.
function initSlots(slotChoices: string[], kind: HarnessKind): Record<string, SlotState> {
  const preselect = kind === 'command' || slotChoices.length === 1
  return Object.fromEntries(
    slotChoices.map((s) => [s, { enabled: preselect, path: '' }])
  ) as Record<string, SlotState>
}

// 레포↔하니스 연결 다이얼로그(zero-input) — 연결 고르기 → 레포 고르기 → 슬롯 고르기 → 데이터셋 → 저장 → 셋업 PR.
// 사용자는 워크플로 YAML 이나 client ID 를 만지지 않는다. 저장은 admin 만(비-admin 은 읽기 전용 + 안내).
export function ConnectRepoDialog({
  open,
  onClose,
  harnessId,
  kind,
  slotChoices,
  datasets,
  connections,
  workspace,
  canWrite,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  harnessId: string
  kind: HarnessKind
  slotChoices: string[] // service=서비스 이름들, command=['image'], process=[]
  datasets: string[] // 데이터셋 id 목록
  connections: ConnectionMeta[] // github | github-enterprise 로 필터된 내 연결
  workspace: string
  canWrite: boolean
  onSaved: (links: CiLink[]) => void
}) {
  const [connectionId, setConnectionId] = useState('')
  const [repos, setRepos] = useState<RepoInfo[]>()
  const [reposError, setReposError] = useState<string>()
  const [reposLoading, startReposLoad] = useTransition()
  const [repoQuery, setRepoQuery] = useState('')
  const [repository, setRepository] = useState('')
  const [slots, setSlots] = useState<Record<string, SlotState>>(() => initSlots(slotChoices, kind))
  const [dataset, setDataset] = useState('')
  const [saveError, setSaveError] = useState<string>()
  const [saving, startSaving] = useTransition()
  const [savedRepo, setSavedRepo] = useState<string>() // 저장 성공한 레포(셋업 PR 단계로 전환)

  // 열릴 때마다 초기화 + 연결이 하나면 자동 선택(즉시 레포 로드).
  useEffect(() => {
    if (!open) return
    setRepos(undefined)
    setReposError(undefined)
    setRepoQuery('')
    setRepository('')
    setSlots(initSlots(slotChoices, kind))
    setDataset('')
    setSaveError(undefined)
    setSavedRepo(undefined)
    setConnectionId(connections.length === 1 && connections[0] ? connections[0].id : '')
    // 슬롯/연결 목록은 열리는 순간의 스냅샷으로 고정(open 토글에만 반응).
  }, [open])

  // 연결이 정해지면 그 연결로 레포 목록을 불러온다(내 GitHub 토큰 프록시).
  useEffect(() => {
    if (!open || !connectionId) return
    setRepos(undefined)
    setReposError(undefined)
    setRepository('')
    startReposLoad(async () => {
      const r = await listConnectionReposAction(connectionId)
      if (r.ok && r.repos) setRepos(r.repos)
      else setReposError(r.error ?? '레포 목록을 불러오지 못했습니다.')
    })
  }, [connectionId, open])

  const filteredRepos = (repos ?? []).filter((r) =>
    r.fullName.toLowerCase().includes(repoQuery.trim().toLowerCase())
  )
  const enabledSlots = Object.entries(slots).filter(([, s]) => s.enabled)

  function toggleSlot(name: string) {
    setSlots((prev) => {
      const cur = prev[name] ?? { enabled: false, path: '' }
      return { ...prev, [name]: { ...cur, enabled: !cur.enabled } }
    })
  }
  function setSlotPath(name: string, path: string) {
    setSlots((prev) => {
      const cur = prev[name] ?? { enabled: true, path: '' }
      return { ...prev, [name]: { ...cur, path } }
    })
  }

  function onSave() {
    setSaveError(undefined)
    const slotPayload: Record<string, { path?: string }> = {}
    for (const [name, s] of enabledSlots)
      slotPayload[name] = s.path.trim() ? { path: s.path.trim() } : {}
    startSaving(async () => {
      const r = await upsertCiLinkAction({
        repository,
        harness: harnessId,
        ...(dataset ? { dataset } : {}),
        slots: slotPayload,
      })
      if (r.ok && r.links) {
        onSaved(r.links)
        setSavedRepo(repository)
      } else setSaveError(r.error ?? '링크 저장에 실패했습니다.')
    })
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-[560px]" labelledBy="ci-connect-title">
      <header className="border-b border-border px-5 py-4">
        <h2 id="ci-connect-title" className="text-[15px] font-[560] text-foreground">
          GitHub 레포 연결
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          레포를 <span className="font-mono">{harnessId}</span> 하니스에 연결하면, PR·머지마다 CI 가
          이미지를 빌드해 이 하니스로 평가합니다. 링크의 존재 자체가 그 레포의 keyless CI(OIDC)
          신뢰가 됩니다 — 워크플로 YAML 은 셋업 PR 로 자동 생성됩니다.
        </p>
      </header>

      {connections.length === 0 ? (
        // 연결 없음 — 계정 페이지로 안내(개인 소유 OAuth).
        <div className="space-y-3 px-5 py-5">
          <Callout tone="info">
            먼저 GitHub 계정을 연결해야 레포를 고를 수 있습니다.
            <div className="mt-2">
              <Link
                href={`/${encodeURIComponent(workspace)}/account?tab=connections`}
                className="text-[12px] font-[510] text-primary hover:underline"
              >
                계정 → 연결된 계정에서 GitHub 연결 →
              </Link>
            </div>
          </Callout>
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={onClose}>
              닫기
            </Button>
          </div>
        </div>
      ) : savedRepo ? (
        // 저장 완료 — 셋업 PR 단계.
        <div className="space-y-4 px-5 py-5">
          <Callout tone="info">
            <span className="font-mono text-foreground">{savedRepo}</span> 를{' '}
            <span className="font-mono text-foreground">{harnessId}</span> 에 연결했습니다. 이제
            셋업 PR 을 열면 워크플로 파일이 레포에 추가됩니다 — 머지하면 CI 평가가 시작됩니다.
          </Callout>
          <div className="flex items-center justify-between gap-3">
            <SetupPrButton
              repository={savedRepo}
              connections={connections}
              size="sm"
              onError={setSaveError}
            />
            <Button size="sm" onClick={onClose}>
              완료
            </Button>
          </div>
          {saveError && (
            <Callout tone="danger" className="py-1.5">
              {saveError}
            </Callout>
          )}
        </div>
      ) : (
        <>
          <div className="max-h-[62vh] space-y-5 overflow-y-auto px-5 py-4">
            {/* 1. 연결 — 여럿이면 고르고, 하나면 고정 표시. */}
            {connections.length > 1 ? (
              <div className="space-y-1.5">
                <Label>1. GitHub 연결</Label>
                <Combobox
                  options={connections.map((c) => ({
                    value: c.id,
                    label: c.accountLabel,
                    hint: c.provider,
                  }))}
                  value={connectionId}
                  onChange={setConnectionId}
                  placeholder="연결 선택"
                />
              </div>
            ) : (
              connections[0] && (
                <p className="text-[12px] text-muted-foreground">
                  연결:{' '}
                  <span className="font-mono text-foreground">{connections[0].accountLabel}</span>
                </p>
              )
            )}

            {/* 2. 레포 picker — 내 연결로 프록시한 목록, 클라이언트 검색. */}
            <div className="space-y-1.5">
              <Label>2. 레포지토리</Label>
              {!connectionId ? (
                <p className="text-[12px] text-muted-foreground">먼저 연결을 선택하세요.</p>
              ) : reposLoading ? (
                <p className="text-[12px] text-muted-foreground">레포 목록을 불러오는 중…</p>
              ) : reposError ? (
                <Callout tone="danger" className="py-1.5">
                  {reposError}
                </Callout>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 shadow-raise focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/25">
                    <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
                    <input
                      value={repoQuery}
                      onChange={(e) => setRepoQuery(e.target.value)}
                      placeholder="레포 검색…"
                      className="h-8 w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                    />
                  </div>
                  <div className="max-h-52 divide-y divide-border/70 overflow-y-auto rounded-md border bg-card">
                    {filteredRepos.length === 0 ? (
                      <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                        {(repos ?? []).length === 0
                          ? '연결된 계정에 접근 가능한 레포가 없습니다.'
                          : '검색 결과가 없습니다.'}
                      </p>
                    ) : (
                      filteredRepos.map((r) => {
                        const active = r.fullName === repository
                        return (
                          <button
                            key={r.fullName}
                            type="button"
                            onClick={() => setRepository(r.fullName)}
                            className={cn(
                              'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                              active ? 'bg-accent' : 'hover:bg-accent/60'
                            )}
                          >
                            <Check
                              className={cn(
                                'size-3.5 shrink-0 text-primary',
                                active ? 'opacity-100' : 'opacity-0'
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                              {r.fullName}
                            </span>
                            {r.private && (
                              <Lock className="size-3 shrink-0 text-muted-foreground/70" />
                            )}
                            {r.pushedAt && (
                              <time
                                className="shrink-0 font-mono text-[10.5px] text-faint"
                                title={fmtDateTimeFull(r.pushedAt)}
                              >
                                {fmtDateTime(r.pushedAt)}
                              </time>
                            )}
                          </button>
                        )
                      })
                    )}
                  </div>
                </>
              )}
            </div>

            {/* 3. 슬롯 — service=서비스 다중선택(+경로), command=image, process=없음. */}
            {repository && (
              <div className="space-y-2">
                <Label>3. 빌드 슬롯</Label>
                {slotChoices.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">
                    이 하니스는 CI 가 갈아끼울 이미지 슬롯이 없습니다(process). 링크는 트리거만
                    담당합니다.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {slotChoices.map((name) => {
                      const s = slots[name] ?? { enabled: false, path: '' }
                      return (
                        <div key={name} className="rounded-md border bg-card px-3 py-2">
                          <label className="flex cursor-pointer items-center gap-2.5">
                            <input
                              type="checkbox"
                              className="accent-primary"
                              checked={s.enabled}
                              onChange={() => toggleSlot(name)}
                            />
                            <span className="font-mono text-[12px] font-[510] text-foreground">
                              {name}
                            </span>
                          </label>
                          {s.enabled && (
                            <div className="mt-2 pl-[26px]">
                              <Input
                                value={s.path}
                                placeholder="모노레포 경로 (선택, 예: services/api)"
                                onChange={(e) => setSlotPath(name, e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 4. 데이터셋 — CI 가 발사할 벤치마크(선택). */}
            {repository && datasets.length > 0 && (
              <div className="space-y-1.5">
                <Label>4. 데이터셋 (선택)</Label>
                <Combobox
                  options={[
                    { value: '', label: '지정 안 함', hint: '나중에' },
                    ...datasets.map((d) => ({ value: d })),
                  ]}
                  value={dataset}
                  onChange={setDataset}
                  placeholder="데이터셋 선택"
                />
                <p className="text-[12px] text-faint">
                  미지정 시 셋업 PR 워크플로에 TODO 로 남습니다 — 나중에 채워도 됩니다.
                </p>
              </div>
            )}

            {!canWrite && (
              <Callout tone="warning" className="py-1.5">
                링크 저장은 admin 권한(settings:write)이 필요합니다. 관리자에게 요청하세요 — 링크는
                그 레포의 keyless CI 신뢰를 부여합니다.
              </Callout>
            )}
            {saveError && (
              <Callout tone="danger" className="py-1.5">
                {saveError}
              </Callout>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            <span className="text-[12px] text-faint">
              {repository ? (
                <>
                  <span className="font-mono text-muted-foreground">{repository}</span> ·{' '}
                  {enabledSlots.length}개 슬롯
                </>
              ) : (
                '레포를 선택하세요'
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                취소
              </Button>
              <Button size="sm" disabled={!canWrite || !repository || saving} onClick={onSave}>
                <GitBranch />
                {saving ? '저장 중…' : '연결 저장'}
              </Button>
            </div>
          </footer>
        </>
      )}
    </Dialog>
  )
}
