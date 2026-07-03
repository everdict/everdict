'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Boxes, Clock, Database, Search, Waypoints } from 'lucide-react'

import type { DatasetSummary } from '@/entities/dataset'
import type { DatasetRelation } from '@/shared/lib/dataset-relations'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { sortSemverDesc } from '@/shared/lib/semver'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { Score } from '@/shared/ui/score'
import { StatCard } from '@/shared/ui/stat-card'

type Sort = 'name' | 'updated' | 'cases'
type Author = { name: string; avatarUrl?: string }

const SORTS: { value: Sort; label: string }[] = [
  { value: 'name', label: '이름순' },
  { value: 'updated', label: '최근 수정순' },
  { value: 'cases', label: '케이스 많은순' },
]

const STATUS_LABEL: Record<string, string> = {
  succeeded: '성공',
  failed: '실패',
  running: '실행중',
  queued: '대기',
}

// 최근 실행 결과 — 성공이면 점수(통과율/평균), 아니면 상태 라벨. 실행 이력 없으면 dash.
function LatestResult({ rel }: { rel?: DatasetRelation }) {
  if (!rel || !rel.lastStatus) return <span className="text-faint">실행 이력 없음</span>
  if (rel.lastStatus === 'succeeded') {
    return <Score passRate={rel.lastPassRate} mean={rel.lastMean} />
  }
  return (
    <span
      className={cn(rel.lastStatus === 'failed' ? 'text-destructive' : 'text-muted-foreground')}
    >
      {STATUS_LABEL[rel.lastStatus] ?? rel.lastStatus}
    </span>
  )
}

export function DatasetList({
  workspace,
  datasets,
  relations,
  authors,
}: {
  workspace: string
  datasets: DatasetSummary[]
  relations: Record<string, DatasetRelation>
  authors: Record<string, Author>
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('name')
  const [category, setCategory] = useState('') // 태그 필터('' = 전체)
  const [user, setUser] = useState('') // 만든이(createdBy) 필터('' = 전체)

  const totalCases = datasets.reduce((n, d) => n + (d.caseCount ?? 0), 0)
  const tagCount = useMemo(() => new Set(datasets.flatMap((d) => d.tags)).size, [datasets])
  const ranCount = datasets.filter((d) => relations[d.id]?.lastStatus).length

  // 만든이 정보 — createdBy(있으면 members 프로필) 있으면 표시. 없으면(시드 등) '—'.
  function authorInfo(d: DatasetSummary): { name: string; avatarUrl?: string; known: boolean } {
    if (d.createdBy) {
      const a = authors[d.createdBy]
      return {
        name: a?.name ?? fmtSubject(d.createdBy),
        ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
        known: true,
      }
    }
    return { name: '—', known: false }
  }

  // 필터 dropdown 옵션 — 카테고리(전 데이터셋 태그) · 사용자(등록자).
  const categoryOptions = useMemo(() => {
    const s = new Set<string>()
    for (const d of datasets) for (const t of d.tags) s.add(t)
    return [
      { value: '', label: '전체 카테고리' },
      ...[...s].sort().map((t) => ({ value: t, label: t })),
    ]
  }, [datasets])

  const userOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of datasets) {
      if (d.createdBy) m.set(d.createdBy, authors[d.createdBy]?.name ?? fmtSubject(d.createdBy))
    }
    return [
      { value: '', label: '전체 사용자' },
      ...[...m.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([sub, name]) => ({ value: sub, label: name })),
    ]
  }, [datasets, authors])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = datasets.filter((d) => {
      if (category && !d.tags.includes(category)) return false
      if (user && d.createdBy !== user) return false
      if (!q) return true
      const hay = [d.id, d.description ?? '', ...d.tags, ...(relations[d.id]?.harnesses ?? [])]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
    const by: Record<Sort, (a: DatasetSummary, b: DatasetSummary) => number> = {
      name: (a, b) => a.id.localeCompare(b.id),
      updated: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      cases: (a, b) => (b.caseCount ?? 0) - (a.caseCount ?? 0),
    }
    return [...matched].sort(by[sort])
  }, [datasets, relations, query, sort, category, user])

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="데이터셋" value={datasets.length} />
        <StatCard label="케이스 합계" value={totalCases} />
        <StatCard label="카테고리" value={tagCount} />
        <StatCard label="실행됨" value={ranCount} tone={ranCount > 0 ? 'primary' : 'default'} />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="id · 설명 · 태그 · 하니스로 검색"
            className="pl-8"
            aria-label="데이터셋 검색"
          />
        </div>
        <Combobox
          options={categoryOptions}
          value={category}
          onChange={setCategory}
          placeholder="카테고리"
          className="w-[150px]"
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
          title="조건에 맞는 데이터셋이 없어요."
          hint="검색어나 필터를 바꿔보세요."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((d) => {
            const latest = d.latestVersion ?? sortSemverDesc(d.versions)[0]
            const rel = relations[d.id]
            const author = authorInfo(d)
            return (
              <Link
                key={d.id}
                href={`/${workspace}/datasets/${encodeURIComponent(d.id)}`}
                className="group block rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
                      <Database className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-[560] text-foreground">
                          {d.id}
                        </span>
                        {latest && (
                          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                            v{latest}
                          </code>
                        )}
                        {d.versions.length > 1 && (
                          <span className="text-[11px] text-faint">
                            +{d.versions.length - 1}개 버전
                          </span>
                        )}
                      </div>
                      {d.description && (
                        <p className="line-clamp-1 text-[12.5px] text-muted-foreground">
                          {d.description}
                        </p>
                      )}
                      {d.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {d.tags.slice(0, 4).map((t) => (
                            <span
                              key={t}
                              className="rounded bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                            >
                              {t}
                            </span>
                          ))}
                          {d.tags.length > 4 && (
                            <span className="text-[10.5px] text-faint">+{d.tags.length - 4}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* 만든이 — 프로필 아바타 + 이름(자연스러운 신원 표기) */}
                  {author.known && (
                    <span
                      className="flex shrink-0 items-center gap-1.5"
                      title={`만든이 ${author.name}`}
                    >
                      <Avatar name={author.name} url={author.avatarUrl} size="sm" />
                      <span className="max-w-[120px] truncate text-[11.5px] text-muted-foreground">
                        {author.name}
                      </span>
                    </span>
                  )}
                </div>

                {/* 메타 라인 — 케이스 · 관계 하니스 · 최근 실행(결과+시각) */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-11 text-[11.5px] text-faint">
                  <span className="inline-flex items-center gap-1">
                    <Boxes className="size-3.5" />
                    케이스{' '}
                    <span className="tabular-nums text-muted-foreground">{d.caseCount ?? 0}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Waypoints className="size-3.5" />
                    {rel && rel.harnesses.length > 0 ? (
                      <span className="inline-flex flex-wrap items-center gap-1">
                        {rel.harnesses.slice(0, 3).map((h) => (
                          <code
                            key={h}
                            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground"
                          >
                            {h}
                          </code>
                        ))}
                        {rel.harnesses.length > 3 && (
                          <span className="text-faint">+{rel.harnesses.length - 3}</span>
                        )}
                      </span>
                    ) : (
                      <span>하니스 없음</span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-faint">최근 결과</span>
                    <LatestResult rel={rel} />
                  </span>
                  {rel?.lastRunAt && (
                    <span
                      className="inline-flex items-center gap-1"
                      title={`최근 실행 ${fmtDateTimeFull(rel.lastRunAt)}`}
                    >
                      <Clock className="size-3.5" />
                      {fmtDateTime(rel.lastRunAt)}
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
