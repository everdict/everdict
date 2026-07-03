'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'

import type { ScorecardRecord } from '@/entities/scorecard'
import {
  dayKeyOf,
  fmtDateHeading,
  fmtDateTime,
  fmtDateTimeFull,
  fmtSubject,
  fmtTimeOnly,
} from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { EntityRef, MetricChip, ModelChip } from '@/shared/ui/chip'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { OriginChip } from '@/shared/ui/origin'
import { StatCard } from '@/shared/ui/stat-card'
import { StatusIcon } from '@/shared/ui/status-pill'

type Sort = 'recent' | 'name'
type Author = { name: string; avatarUrl?: string }

const SORTS: { value: Sort; label: string }[] = [
  { value: 'recent', label: '최신순' },
  { value: 'name', label: '이름순' },
]

const STATUS_OPTIONS = [
  { value: '', label: '전체 상태' },
  { value: 'succeeded', label: '성공' },
  { value: 'running', label: '실행중' },
  { value: 'queued', label: '대기' },
  { value: 'failed', label: '실패' },
  { value: 'superseded', label: '대체됨' },
]

// 스코어카드 목록 — 데이터셋 목록과 동일한 패턴(검색 + Combobox 필터 + 정렬 + 실행자 아바타).
export function ScorecardList({
  workspace,
  scorecards,
  authors,
}: {
  workspace: string
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('recent')
  const [dataset, setDataset] = useState('') // 데이터셋 필터('' = 전체)
  const [harness, setHarness] = useState('') // 하니스 필터('' = 전체)
  const [status, setStatus] = useState('') // 상태 필터('' = 전체)
  const [user, setUser] = useState('') // 실행자(createdBy) 필터('' = 전체)

  const total = scorecards.length
  const succeeded = scorecards.filter((s) => s.status === 'succeeded').length
  const running = scorecards.filter((s) => s.status === 'running' || s.status === 'queued').length
  const failed = scorecards.filter((s) => s.status === 'failed').length

  // 실행자 정보 — createdBy(있으면 members 프로필) 있으면 표시. 없으면(과거 레코드/기계 발사) 숨김.
  function authorInfo(s: ScorecardRecord): { name: string; avatarUrl?: string; known: boolean } {
    if (s.createdBy) {
      const a = authors[s.createdBy]
      return {
        name: a?.name ?? fmtSubject(s.createdBy),
        ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
        known: true,
      }
    }
    return { name: '—', known: false }
  }

  // 필터 dropdown 옵션 — 데이터셋 · 하니스 · 실행자(전 스코어카드에서 도출).
  const datasetOptions = useMemo(() => {
    const s = new Set(scorecards.map((c) => c.dataset.id))
    return [
      { value: '', label: '전체 데이터셋' },
      ...[...s].sort().map((d) => ({ value: d, label: d })),
    ]
  }, [scorecards])

  const harnessOptions = useMemo(() => {
    const s = new Set(scorecards.map((c) => c.harness.id))
    return [
      { value: '', label: '전체 하니스' },
      ...[...s].sort().map((h) => ({ value: h, label: h })),
    ]
  }, [scorecards])

  const userOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of scorecards) {
      if (c.createdBy) m.set(c.createdBy, authors[c.createdBy]?.name ?? fmtSubject(c.createdBy))
    }
    return [
      { value: '', label: '전체 사용자' },
      ...[...m.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([sub, name]) => ({ value: sub, label: name })),
    ]
  }, [scorecards, authors])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = scorecards.filter((s) => {
      if (dataset && s.dataset.id !== dataset) return false
      if (harness && s.harness.id !== harness) return false
      if (status && s.status !== status) return false
      if (user && s.createdBy !== user) return false
      if (!q) return true
      const hay = [
        s.dataset.id,
        s.harness.id,
        s.models?.primary ?? '',
        ...(s.judgeModels ?? []),
        s.origin?.source ?? '',
        s.createdBy ? (authors[s.createdBy]?.name ?? s.createdBy) : '',
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
    const by: Record<Sort, (a: ScorecardRecord, b: ScorecardRecord) => number> = {
      recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
      name: (a, b) =>
        a.dataset.id.localeCompare(b.dataset.id) || a.harness.id.localeCompare(b.harness.id),
    }
    return [...matched].sort(by[sort])
  }, [scorecards, authors, query, sort, dataset, harness, status, user])

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="전체" value={total} />
        <StatCard label="성공" value={succeeded} tone={succeeded > 0 ? 'success' : 'default'} />
        <StatCard label="진행중" value={running} tone={running > 0 ? 'primary' : 'default'} />
        <StatCard label="실패" value={failed} tone={failed > 0 ? 'danger' : 'default'} />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="데이터셋 · 하니스 · 모델 · 실행자로 검색"
            className="pl-8"
            aria-label="스코어카드 검색"
          />
        </div>
        <Combobox
          options={datasetOptions}
          value={dataset}
          onChange={setDataset}
          placeholder="데이터셋"
          className="w-[150px]"
        />
        <Combobox
          options={harnessOptions}
          value={harness}
          onChange={setHarness}
          placeholder="하니스"
          className="w-[150px]"
        />
        <Combobox
          options={STATUS_OPTIONS}
          value={status}
          onChange={setStatus}
          placeholder="상태"
          className="w-[130px]"
        />
        {userOptions.length > 1 && (
          <Combobox
            options={userOptions}
            value={user}
            onChange={setUser}
            placeholder="사용자"
            className="w-[150px]"
          />
        )}
        <Combobox
          options={SORTS.map((s) => ({ value: s.value, label: s.label }))}
          value={sort}
          onChange={(v) => setSort(v as Sort)}
          className="w-[130px]"
          align="end"
          aria-label="정렬"
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="조건에 맞는 스코어카드가 없어요."
          hint="검색어나 필터를 바꿔보세요."
        />
      ) : (
        <div className="space-y-4">
          {(sort === 'recent'
            ? // recent 정렬: 날짜별 그룹(헤더=오늘/어제/M월 D일, 행에는 시간만)
              [
                ...visible
                  .reduce((m, s) => {
                    const k = dayKeyOf(s.createdAt)
                    const g = m.get(k)
                    if (g) g.push(s)
                    else m.set(k, [s])
                    return m
                  }, new Map<string, ScorecardRecord[]>())
                  .entries(),
              ]
            : ([['', visible]] as Array<[string, ScorecardRecord[]]>)
          ).map(([day, items]) => (
            <section key={day || 'all'} className="space-y-2">
              {day && items[0] && (
                <h4 className="px-0.5 text-[11.5px] font-[560] uppercase tracking-wide text-faint">
                  {fmtDateHeading(items[0].createdAt)}
                </h4>
              )}
              {items.map((s, i) => {
                const author = authorInfo(s)
                const metrics = s.summary ?? []
                const shownMetrics = metrics.slice(0, 3) // 카드 규격 유지 — 상위 3개만, 나머지는 +N
                const judges = s.judgeModels ?? []
                return (
                  // 고정 규격 카드 — 3줄(데이터셋/하니스/집계), 화살표·인라인 이름 없음. 상태는 색상 아이콘만.
                  <Link
                    key={s.id}
                    href={`/${workspace}/scorecards/${encodeURIComponent(s.id)}`}
                    style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                    className="rise flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
                  >
                    {/* 좌: 3줄 — ① 데이터셋 ② 하니스(+모델·출처) ③ 집계 칩. 각 한 줄, 잘림 없이 truncate. */}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center overflow-hidden whitespace-nowrap text-[13px] font-[510]">
                        <span className="truncate">
                          <EntityRef id={s.dataset.id} version={s.dataset.version} />
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] font-[510]">
                        <span className="truncate">
                          <EntityRef id={s.harness.id} version={s.harness.version} />
                        </span>
                        {s.models?.primary ? (
                          <span className="hidden shrink-0 sm:inline-flex">
                            <ModelChip>{s.models.primary}</ModelChip>
                          </span>
                        ) : null}
                        {s.origin ? (
                          <span className="hidden shrink-0 md:inline-flex">
                            <OriginChip origin={s.origin} />
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1 overflow-hidden whitespace-nowrap">
                        {shownMetrics.length > 0 ? (
                          shownMetrics.map((m) => (
                            <span key={m.metric} className="shrink-0">
                              <MetricChip metric={m.metric} mean={m.mean} passRate={m.passRate} />
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-faint">
                            {s.status === 'failed' ? '집계 없음' : '집계 대기'}
                          </span>
                        )}
                        {metrics.length > shownMetrics.length && (
                          <span className="shrink-0 text-[11px] text-faint">
                            +{metrics.length - shownMetrics.length}
                          </span>
                        )}
                        {judges.length > 0 && (
                          <span className="ml-1 hidden shrink-0 items-center gap-1 lg:inline-flex">
                            <span className="text-[10px] uppercase tracking-wide text-faint">
                              judge
                            </span>
                            <ModelChip muted>{judges[0]}</ModelChip>
                            {judges.length > 1 && (
                              <span className="text-[11px] text-faint">+{judges.length - 1}</span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* 우: 고정 슬롯 — 실행자(썸네일) · 시각(그룹=시간만) · 상태(색상 아이콘). */}
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className="flex w-6 justify-center">
                        {author.known && (
                          <UserAvatar name={author.name} url={author.avatarUrl} label="실행자" />
                        )}
                      </span>
                      <time
                        className={
                          sort === 'recent'
                            ? 'hidden w-[44px] text-right font-mono text-[11px] text-muted-foreground sm:block'
                            : 'hidden w-[84px] text-right font-mono text-[11px] text-muted-foreground sm:block'
                        }
                        title={fmtDateTimeFull(s.createdAt)}
                      >
                        {sort === 'recent' ? fmtTimeOnly(s.createdAt) : fmtDateTime(s.createdAt)}
                      </time>
                      <span className="flex w-5 justify-end">
                        <StatusIcon status={s.status} />
                      </span>
                    </div>
                  </Link>
                )
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
