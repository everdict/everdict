'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'

import type { ScorecardRecord } from '@/entities/scorecard'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { Avatar } from '@/shared/ui/avatar'
import { EntityRef, MetricChip, ModelChip } from '@/shared/ui/chip'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Select } from '@/shared/ui/input'
import { OriginChip } from '@/shared/ui/origin'
import { StatCard } from '@/shared/ui/stat-card'
import { StatusPill } from '@/shared/ui/status-pill'

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
        <Select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="w-auto"
          aria-label="정렬"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="조건에 맞는 스코어카드가 없습니다."
          hint="검색어나 필터를 바꿔보세요."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((s, i) => {
            const author = authorInfo(s)
            return (
              <Link
                key={s.id}
                href={`/${workspace}/scorecards/${encodeURIComponent(s.id)}`}
                style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                className="rise grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] font-[510]">
                    <EntityRef id={s.dataset.id} version={s.dataset.version} />
                    <span className="text-faint">→</span>
                    <EntityRef id={s.harness.id} version={s.harness.version} />
                    {s.models?.primary ? <ModelChip>{s.models.primary}</ModelChip> : null}
                    {s.origin ? <OriginChip origin={s.origin} /> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {(s.summary ?? []).length > 0 ? (
                      (s.summary ?? []).map((m) => (
                        <MetricChip
                          key={m.metric}
                          metric={m.metric}
                          mean={m.mean}
                          passRate={m.passRate}
                        />
                      ))
                    ) : (
                      <span className="text-[11px] text-faint">
                        {s.status === 'failed' ? '집계 없음' : '집계 대기'}
                      </span>
                    )}
                    {s.judgeModels && s.judgeModels.length > 0 ? (
                      <span className="ml-1 inline-flex items-center gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-faint">
                          judge
                        </span>
                        {s.judgeModels.map((jm) => (
                          <ModelChip key={jm} muted>
                            {jm}
                          </ModelChip>
                        ))}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusPill status={s.status} />
                  <time
                    className="font-mono text-[11px] text-muted-foreground"
                    title={fmtDateTimeFull(s.createdAt)}
                  >
                    {fmtDateTime(s.createdAt)}
                  </time>
                  {/* 실행자 — 프로필 아바타 + 이름(데이터셋 목록의 만든이와 동일 표기) */}
                  {author.known && (
                    <span className="flex items-center gap-1.5" title={`실행자 ${author.name}`}>
                      <Avatar name={author.name} url={author.avatarUrl} size="sm" />
                      <span className="max-w-[120px] truncate text-[11.5px] text-muted-foreground">
                        {author.name}
                      </span>
                    </span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
