'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { Check, GitBranch, Lock, Search } from 'lucide-react'

import type { CiLink, CiTrigger, RepoInfo } from '@/entities/ci-link'
import type { HarnessKind } from '@/entities/harness'
import type { RunnerMeta } from '@/entities/runner'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'

import {
  listGithubAppReposAction,
  listSharedRunnersAction,
  upsertCiLinkAction,
} from '../api/manage-ci-links'
import { SetupPrButton } from './setup-pr-button'

interface SlotState {
  enabled: boolean
  path: string
}

// picker 선택 좌표 — 같은 "owner/name" 이 github.com 과 GHE 양쪽에 있을 수 있어 host 까지가 식별자다.
interface SelectedRepo {
  fullName: string
  host?: string // GHE 베이스 URL — 미지정 = github.com
}

const repoKey = (r: SelectedRepo) => `${r.host ?? 'github.com'}:${r.fullName}`
// GHE host 표시는 URL 스킴을 뗀 호스트명만 — picker 행/패널 배지 공용.
export const hostLabel = (host: string) => host.replace(/^https?:\/\//, '').replace(/\/$/, '')

// 슬롯 초기값 — command 는 image 를 기본 선택, 서비스 슬롯이 하나뿐이면 자동 선택, 여럿이면 사용자가 고른다.
function initSlots(slotChoices: string[], kind: HarnessKind): Record<string, SlotState> {
  const preselect = kind === 'command' || slotChoices.length === 1
  return Object.fromEntries(
    slotChoices.map((s) => [s, { enabled: preselect, path: '' }])
  ) as Record<string, SlotState>
}

// 공유 러너 준비 상태 — CI 워크플로는 항상 셀프호스티드 러너에서 실행(D6)되므로 연결 시점에 풀 상태를 보여준다.
// unavailable = 조회 불가(비관리자/조회 실패) — 안내 문구만.
type RunnerCheck =
  | { state: 'loading' }
  | { state: 'ready'; runners: RunnerMeta[] }
  | { state: 'unavailable' }

// 온라인 판정 — 러너는 long-poll lease(~25s)마다 lastSeenAt 을 갱신하므로 90s 안이면 접속 중(공유 러너 탭과 동일 관례).
const ONLINE_WINDOW_MS = 90_000
const isOnline = (lastSeenAt?: string) =>
  lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS

// 레포↔하니스 연결 다이얼로그(zero-input) — 레포 고르기 → 슬롯 고르기 → 데이터셋 → 저장 → 셋업 PR.
// 레포 목록은 워크스페이스 GitHub App installation 이 접근 가능한 것(설치 시 고른 것만). 저장은 admin 만.
export function ConnectRepoDialog({
  open,
  onClose,
  harnessId,
  kind,
  slotChoices,
  datasets,
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
  workspace: string
  canWrite: boolean
  onSaved: (links: CiLink[]) => void
}) {
  const [repos, setRepos] = useState<RepoInfo[]>()
  const [reposError, setReposError] = useState<string>()
  const [reposLoading, startReposLoad] = useTransition()
  const [repoQuery, setRepoQuery] = useState('')
  const [repository, setRepository] = useState<SelectedRepo>()
  const [slots, setSlots] = useState<Record<string, SlotState>>(() => initSlots(slotChoices, kind))
  const [dataset, setDataset] = useState('')
  const [trigger, setTrigger] = useState<CiTrigger>('both')
  const [runsOn, setRunsOn] = useState('')
  const [runtime, setRuntime] = useState('')
  const [saveError, setSaveError] = useState<string>()
  const [saving, startSaving] = useTransition()
  const [savedRepo, setSavedRepo] = useState<SelectedRepo>() // 저장 성공한 레포(셋업 PR 단계로 전환)
  const [runnerCheck, setRunnerCheck] = useState<RunnerCheck>({ state: 'loading' })

  // 열릴 때마다 초기화 + 워크스페이스 App installation 의 레포 목록 로드.
  useEffect(() => {
    if (!open) return
    setReposError(undefined)
    setRepoQuery('')
    setRepository(undefined)
    setSlots(initSlots(slotChoices, kind))
    setDataset('')
    setTrigger('both')
    setRunsOn('')
    setRuntime('')
    setSaveError(undefined)
    setSavedRepo(undefined)
    setRepos(undefined)
    setRunnerCheck(canWrite ? { state: 'loading' } : { state: 'unavailable' })
    startReposLoad(async () => {
      const r = await listGithubAppReposAction()
      if (r.ok && r.repos) setRepos(r.repos)
      else setReposError(r.error ?? '레포 목록을 불러오지 못했습니다.')
    })
    // 공유 러너 준비 상태 — 조회 게이트가 admin(settings:write)이라 canWrite 일 때만. 실패는 안내 문구로 강등.
    if (canWrite)
      void listSharedRunnersAction().then((r) =>
        setRunnerCheck(
          r.ok && r.runners ? { state: 'ready', runners: r.runners } : { state: 'unavailable' }
        )
      )
    // 슬롯/레포 목록은 열리는 순간의 스냅샷으로 고정(open 토글에만 반응).
  }, [open])

  // 검색은 레포명 + GHE 호스트명 모두에 매칭(호스트로 좁혀 찾을 수 있게).
  const filteredRepos = (repos ?? []).filter((r) =>
    `${r.fullName} ${r.host ? hostLabel(r.host) : ''}`
      .toLowerCase()
      .includes(repoQuery.trim().toLowerCase())
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
    if (!repository) return
    setSaveError(undefined)
    const slotPayload: Record<string, { path?: string }> = {}
    for (const [name, s] of enabledSlots)
      slotPayload[name] = s.path.trim() ? { path: s.path.trim() } : {}
    startSaving(async () => {
      const r = await upsertCiLinkAction({
        repository: repository.fullName,
        ...(repository.host ? { host: repository.host } : {}),
        harness: harnessId,
        ...(dataset ? { dataset } : {}),
        slots: slotPayload,
        ...(trigger !== 'both' ? { trigger } : {}), // 미지정 = both 가 계약 — 기본값은 저장하지 않는다
        ...(runsOn.trim() ? { runsOn: runsOn.trim() } : {}),
        ...(runtime.trim() ? { runtime: runtime.trim() } : {}),
      })
      if (r.ok && r.links) {
        onSaved(r.links)
        setSavedRepo(repository)
      } else setSaveError(r.error ?? '링크 저장에 실패했습니다.')
    })
  }

  const noRepos = repos !== undefined && repos.length === 0

  return (
    <Dialog open={open} onClose={onClose} className="max-w-[560px]" labelledBy="ci-connect-title">
      <header className="border-b border-border px-5 py-4">
        <h2 id="ci-connect-title" className="text-[15px] font-[560] text-foreground">
          GitHub 레포 연결
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          레포를 <span className="font-mono">{harnessId}</span> 하니스에 연결하면, PR·머지마다 CI가
          이미지를 만들어 자동으로 평가해요. 워크플로 파일은 셋업 PR로 자동 만들어져요.
        </p>
      </header>

      {noRepos ? (
        // App 미설치/접근 레포 없음 — 설정 → 통합에서 GitHub App 설치 안내.
        <div className="space-y-3 px-5 py-5">
          <Callout tone="info">
            연결할 수 있는 레포가 없어요. 관리자가 워크스페이스에 GitHub App 을 설치하고 저장소를
            선택해야 여기에 보여요.
            <div className="mt-2">
              <Link
                href={`/${encodeURIComponent(workspace)}/settings?tab=integrations`}
                className="text-[12px] font-[510] text-primary hover:underline"
              >
                설정 → 통합에서 GitHub App 설치하기 →
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
            <span className="font-mono text-foreground">{savedRepo.fullName}</span>
            {savedRepo.host && (
              <span className="font-mono text-muted-foreground">
                {' '}
                ({hostLabel(savedRepo.host)})
              </span>
            )}{' '}
            를 <span className="font-mono text-foreground">{harnessId}</span> 에 연결했어요. 셋업
            PR을 열면 워크플로 파일이 레포에 추가돼요. 머지하면 CI 평가가 시작돼요.
          </Callout>
          <div className="flex items-center justify-between gap-3">
            <SetupPrButton
              repository={savedRepo.fullName}
              host={savedRepo.host}
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
            {/* 1. 레포 picker — App installation 이 접근 가능한 레포, 클라이언트 검색. */}
            <div className="space-y-1.5">
              <Label>1. 레포지토리</Label>
              {reposLoading || repos === undefined ? (
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
                        검색 결과가 없어요.
                      </p>
                    ) : (
                      filteredRepos.map((r) => {
                        const active =
                          repository !== undefined && repoKey(r) === repoKey(repository)
                        return (
                          <button
                            key={repoKey(r)}
                            type="button"
                            onClick={() =>
                              setRepository({
                                fullName: r.fullName,
                                ...(r.host ? { host: r.host } : {}),
                              })
                            }
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
                            {r.host && (
                              // GHE repo — 어느 인스턴스에서 온 것인지 호스트명으로 구분(github.com 은 무표기).
                              <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                                {hostLabel(r.host)}
                              </span>
                            )}
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

            {/* 2. 슬롯 — service=서비스 다중선택(+경로), command=image, process=없음. */}
            {repository && (
              <div className="space-y-2">
                <Label>2. 빌드 슬롯</Label>
                {slotChoices.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">
                    이 하니스는 CI가 바꿔 끼울 이미지 슬롯이 없어요(process). 링크는 트리거만 해요.
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

            {/* 3. 데이터셋 — CI 가 발사할 벤치마크(선택). */}
            {repository && datasets.length > 0 && (
              <div className="space-y-1.5">
                <Label>3. 데이터셋 (선택)</Label>
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
                  지금 안 정하면 셋업 PR에 TODO로 남아요. 나중에 채워도 돼요.
                </p>
              </div>
            )}

            {/* 4. PR 평가 발화 방식 — 자동/코멘트(/evaluate)/둘 다. push(머지 재핀)는 방식과 무관하게 항상. */}
            {repository && (
              <div className="space-y-1.5">
                <Label>4. PR 평가 방식</Label>
                <Combobox
                  options={[
                    { value: 'both', label: '자동 + /evaluate 코멘트', hint: '기본' },
                    { value: 'auto', label: '자동만', hint: 'PR 푸시마다' },
                    { value: 'comment', label: '/evaluate 코멘트만', hint: '온디맨드' },
                  ]}
                  value={trigger}
                  onChange={(v) => setTrigger(v === 'auto' || v === 'comment' ? v : 'both')}
                  placeholder="발화 방식"
                />
                <p className="text-[12px] text-faint">
                  코멘트 방식은 PR 대화에 <span className="font-mono">/evaluate</span> 를 남기면
                  평가가 돌고 결과가 대화로 회신돼요. 협력자 이상만 발화할 수 있어요.
                </p>
              </div>
            )}

            {/* 5. 실행 러너 — CI 워크플로는 항상 셀프호스티드 러너에서(D6, 사설망 컨트롤플레인 도달). 기본 = 공유 러너 풀. */}
            {repository && (
              <div className="space-y-1.5">
                <Label>5. 실행 러너</Label>
                {runnerCheck.state === 'loading' ? (
                  <p className="text-[12px] text-muted-foreground">공유 러너를 확인하는 중…</p>
                ) : runnerCheck.state === 'ready' && runnerCheck.runners.length === 0 ? (
                  // 러너 0대 — 셋업 PR 이 서버에서 차단되므로(fail-closed) 등록 경로를 먼저 안내한다.
                  <Callout tone="warning" className="py-1.5">
                    공유 러너가 없어요. CI 워크플로는 셀프호스티드 러너에서 실행돼서, 러너를 먼저
                    등록해야 셋업 PR을 열 수 있어요.
                    <div className="mt-1.5">
                      <Link
                        href={`/${encodeURIComponent(workspace)}/settings?tab=runners`}
                        className="text-[12px] font-[510] text-primary hover:underline"
                      >
                        설정 → 공유 러너에서 GitHub Actions 러너 등록하기 →
                      </Link>
                    </div>
                  </Callout>
                ) : runnerCheck.state === 'ready' ? (
                  <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <span
                      className="inline-block size-1.5 shrink-0 rounded-full bg-[var(--color-success)]"
                      aria-hidden
                    />
                    공유 러너 {runnerCheck.runners.length}대 (온라인{' '}
                    {runnerCheck.runners.filter((r) => isOnline(r.lastSeenAt)).length}대) — 팀 러너
                    풀(<span className="font-mono">self:ws</span>)에서 빌드·평가가 실행돼요.
                  </p>
                ) : (
                  <p className="text-[12px] text-muted-foreground">
                    CI 워크플로는 워크스페이스 공유 러너(셀프호스티드)에서 실행돼요. 러너
                    등록·관리는 관리자가 해요.
                  </p>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input
                    value={runsOn}
                    onChange={(e) => setRunsOn(e.target.value)}
                    placeholder="runs-on 오버라이드 (기본 [self-hosted])"
                  />
                  <Input
                    value={runtime}
                    onChange={(e) => setRuntime(e.target.value)}
                    placeholder="runtime 오버라이드 (기본 self:ws)"
                  />
                </div>
                <p className="text-[12px] text-faint">
                  특정 러너로 좁히려면 라벨(예:{' '}
                  <span className="font-mono">[self-hosted, assay-…]</span>)과 런타임(예:{' '}
                  <span className="font-mono">self:ws:…</span>)을 지정해요. 비우면 풀에서 아무
                  러너나 잡아요.
                </p>
              </div>
            )}

            {!canWrite && (
              <Callout tone="warning" className="py-1.5">
                링크 저장은 관리자 권한이 필요해요. 워크스페이스 관리자에게 요청해보세요.
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
                  <span className="font-mono text-muted-foreground">{repository.fullName}</span>
                  {repository.host && <> ({hostLabel(repository.host)})</>} · {enabledSlots.length}
                  개 슬롯
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
