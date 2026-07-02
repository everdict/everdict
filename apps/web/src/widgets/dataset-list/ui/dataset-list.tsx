'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Boxes, Clock, Database, Search, User, Waypoints } from 'lucide-react'

import type { DatasetSummary } from '@/entities/dataset'
import type { DatasetRelation } from '@/shared/lib/dataset-relations'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { sortSemverDesc } from '@/shared/lib/semver'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Select } from '@/shared/ui/input'
import { StatCard } from '@/shared/ui/stat-card'

type Scope = 'all' | 'owned' | 'shared'
type Sort = 'name' | 'updated' | 'cases'

const SORTS: { value: Sort; label: string }[] = [
  { value: 'name', label: '이름순' },
  { value: 'updated', label: '최근 수정순' },
  { value: 'cases', label: '케이스 많은순' },
]

export function DatasetList({
  workspace,
  currentWorkspace,
  datasets,
  relations,
  authors,
}: {
  workspace: string
  currentWorkspace: string
  datasets: DatasetSummary[]
  relations: Record<string, DatasetRelation>
  authors: Record<string, string>
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<Sort>('name')

  const owned = datasets.filter((d) => d.owner === currentWorkspace)
  const sharedCount = datasets.length - owned.length
  const totalCases = datasets.reduce((n, d) => n + (d.caseCount ?? 0), 0)

  // 데이터셋의 만든이 라벨 — createdBy(있으면 members 이름) > 시드/공유는 first-party.
  function authorLabel(d: DatasetSummary): string {
    if (d.createdBy) return authors[d.createdBy] ?? fmtSubject(d.createdBy)
    return d.owner === currentWorkspace ? '—' : 'first-party'
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = datasets.filter((d) => {
      if (scope === 'owned' && d.owner !== currentWorkspace) return false
      if (scope === 'shared' && d.owner === currentWorkspace) return false
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
  }, [datasets, relations, query, scope, sort, currentWorkspace])

  const scopes: { value: Scope; label: string; count: number }[] = [
    { value: 'all', label: '전체', count: datasets.length },
    { value: 'owned', label: '소유', count: owned.length },
    ...(sharedCount > 0 ? [{ value: 'shared' as const, label: '공유', count: sharedCount }] : []),
  ]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="데이터셋" value={datasets.length} />
        <StatCard
          label="소유"
          value={owned.length}
          tone={owned.length > 0 ? 'primary' : 'default'}
        />
        {sharedCount > 0 && <StatCard label="공유" value={sharedCount} />}
        <StatCard label="케이스 합계" value={totalCases} />
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
        {scopes.length > 1 && (
          <div className="flex items-center rounded-md border bg-card p-0.5 shadow-raise">
            {scopes.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setScope(s.value)}
                className={cn(
                  'rounded px-2.5 py-1 text-[12px] font-[510] transition-colors',
                  scope === s.value
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {s.label}
                <span className="ml-1 tabular-nums text-faint">{s.count}</span>
              </button>
            ))}
          </div>
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
          title="조건에 맞는 데이터셋이 없습니다."
          hint="검색어나 필터를 바꿔보세요."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((d) => {
            const isOwned = d.owner === currentWorkspace
            const latest = d.latestVersion ?? sortSemverDesc(d.versions)[0]
            const rel = relations[d.id]
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
                  <Badge tone={isOwned ? 'success' : 'neutral'}>
                    {isOwned ? 'owned' : 'shared'}
                  </Badge>
                </div>

                {/* 메타 라인 — 케이스 · 관계 하니스 · 만든이 · 수정 시각 */}
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
                      <span>실행 이력 없음</span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <User className="size-3.5" />
                    <span className="text-muted-foreground">{authorLabel(d)}</span>
                  </span>
                  {d.updatedAt && (
                    <span
                      className="inline-flex items-center gap-1"
                      title={fmtDateTimeFull(d.updatedAt)}
                    >
                      <Clock className="size-3.5" />
                      {fmtDateTime(d.updatedAt)}
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
