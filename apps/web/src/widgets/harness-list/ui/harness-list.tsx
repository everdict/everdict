'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Boxes, Clock, Layers, Waypoints } from 'lucide-react'

import type { Harness } from '@/entities/harness'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import type { HarnessRelation } from '@/shared/lib/harness-relations'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Select } from '@/shared/ui/input'
import { Score } from '@/shared/ui/score'
import { StatCard } from '@/shared/ui/stat-card'

type Sort = 'name' | 'updated' | 'versions'
type Author = { name: string; avatarUrl?: string }

const SORTS: { value: Sort; label: string }[] = [
  { value: 'name', label: '이름순' },
  { value: 'updated', label: '최근 등록순' },
  { value: 'versions', label: '버전 많은순' },
]

const STATUS_LABEL: Record<string, string> = {
  succeeded: '성공',
  failed: '실패',
  running: '실행중',
  queued: '대기',
}

// 최근 실행 결과 — 성공이면 점수, 아니면 상태 라벨. 실행 이력 없으면 dash.
function LatestResult({ rel }: { rel?: HarnessRelation }) {
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

export function HarnessList({
  workspace,
  harnesses,
  relations,
  authors,
}: {
  workspace: string
  harnesses: Harness[]
  relations: Record<string, HarnessRelation>
  authors: Record<string, Author>
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('name')
  const [category, setCategory] = useState('') // 대분류 필터
  const [user, setUser] = useState('') // 등록자(createdBy) 필터

  const catCount = useMemo(
    () => new Set(harnesses.map((h) => h.category).filter(Boolean)).size,
    [harnesses]
  )
  const ranCount = harnesses.filter((h) => relations[h.id]?.lastStatus).length

  function authorInfo(h: Harness): { name: string; avatarUrl?: string; known: boolean } {
    if (h.createdBy) {
      const a = authors[h.createdBy]
      return {
        name: a?.name ?? fmtSubject(h.createdBy),
        ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
        known: true,
      }
    }
    return { name: '—', known: false }
  }

  const categoryOptions = useMemo(() => {
    const s = new Set<string>()
    for (const h of harnesses) if (h.category) s.add(h.category)
    return [
      { value: '', label: '전체 대분류' },
      ...[...s].sort().map((c) => ({ value: c, label: c })),
    ]
  }, [harnesses])

  const userOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of harnesses) {
      if (h.createdBy) m.set(h.createdBy, authors[h.createdBy]?.name ?? fmtSubject(h.createdBy))
    }
    return [
      { value: '', label: '전체 사용자' },
      ...[...m.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([sub, name]) => ({ value: sub, label: name })),
    ]
  }, [harnesses, authors])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = harnesses.filter((h) => {
      if (category && h.category !== category) return false
      if (user && h.createdBy !== user) return false
      if (!q) return true
      const hay = [h.id, h.category ?? '', h.kind ?? '', h.subtitle ?? ''].join(' ').toLowerCase()
      return hay.includes(q)
    })
    const by: Record<Sort, (a: Harness, b: Harness) => number> = {
      name: (a, b) => a.id.localeCompare(b.id),
      updated: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      versions: (a, b) =>
        (b.versionCount ?? b.versions.length) - (a.versionCount ?? a.versions.length),
    }
    return [...matched].sort(by[sort])
  }, [harnesses, query, sort, category, user])

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="하니스" value={harnesses.length} />
        <StatCard label="대분류" value={catCount} />
        <StatCard label="실행됨" value={ranCount} tone={ranCount > 0 ? 'primary' : 'default'} />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Layers className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="id · 대분류 · kind · 모델로 검색"
            className="pl-8"
            aria-label="하니스 검색"
          />
        </div>
        <Combobox
          options={categoryOptions}
          value={category}
          onChange={setCategory}
          placeholder="대분류"
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
          icon={<Boxes />}
          title="조건에 맞는 하니스가 없습니다."
          hint="검색어나 필터를 바꿔보세요."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((h) => {
            const latest = h.latestVersion ?? h.versions[h.versions.length - 1]
            const nver = h.versionCount ?? h.versions.length
            const rel = relations[h.id]
            const author = authorInfo(h)
            return (
              <Link
                key={h.id}
                href={`/${workspace}/harnesses/${encodeURIComponent(h.id)}`}
                className="group block rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
                      <Boxes className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-[560] text-foreground">
                          {h.id}
                        </span>
                        {latest && (
                          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                            v{latest}
                          </code>
                        )}
                        {nver > 1 && (
                          <span className="text-[11px] text-faint">+{nver - 1}개 버전</span>
                        )}
                      </div>
                      {h.subtitle && (
                        <p className="line-clamp-1 font-mono text-[12px] text-muted-foreground">
                          {h.subtitle}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-1">
                        {h.category && (
                          <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                            {h.category}
                          </span>
                        )}
                        {h.kind && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground">
                            {h.kind}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
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

                {/* 메타 라인 — 버전 · 실행 벤치마크 · 최근 결과(+시각) */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-11 text-[11.5px] text-faint">
                  <span className="inline-flex items-center gap-1">
                    <Layers className="size-3.5" />
                    버전 <span className="tabular-nums text-muted-foreground">{nver}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Waypoints className="size-3.5" />
                    {rel && rel.datasets.length > 0 ? (
                      <span className="inline-flex flex-wrap items-center gap-1">
                        {rel.datasets.slice(0, 3).map((d) => (
                          <code
                            key={d}
                            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground"
                          >
                            {d}
                          </code>
                        ))}
                        {rel.datasets.length > 3 && (
                          <span className="text-faint">+{rel.datasets.length - 3}</span>
                        )}
                      </span>
                    ) : (
                      <span>실행 벤치마크 없음</span>
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
