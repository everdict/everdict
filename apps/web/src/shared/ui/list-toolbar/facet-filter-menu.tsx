'use client'

import { useState, type ReactNode } from 'react'
import { ArrowLeft, Check, ListFilter, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { listFilterCount, type ListFilters } from '@/shared/lib/list-view'
import { cn } from '@/shared/lib/utils'
import { DropdownLabel, DropdownMenu, useDropdownClose } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

// 「필터」 — 리니어의 두 단계 메뉴(축 고르기 → 값 고르기). 적용된 필터는 메뉴 안이 아니라 툴바에 토큰으로
// 서고, 토큰마다 자기 제거 버튼을 갖는다: 걸어 둔 것을 보려고 메뉴를 다시 열어야 한다면 그건 숨긴 것이다.
//
// 어떤 자원의 목록인지 이 컴포넌트는 모른다 — 축과 값은 `facets` 로 받고, 켜고 끄는 일은 `onToggle` 이
// 한다. 이슈 목록과 평가 자원 목록들이 **같은** 필터 UI 를 쓰기 위한 것이고, 그래야 한쪽만 다르게 생기는
// 일이 생기지 않는다.

export interface FacetOption {
  value: string
  label: string
  icon?: ReactNode
}

export interface FacetSpec {
  key: string
  label: string
  options: FacetOption[]
}

export function FacetFilterMenu({
  facets,
  filters,
  onToggle,
  onClear,
}: {
  facets: FacetSpec[]
  filters: ListFilters
  onToggle: (facet: string, value: string) => void
  onClear: () => void
}) {
  const t = useTranslations('listView')
  const active = listFilterCount(filters)

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu
        contentClassName="w-64 p-1"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
          >
            <ListFilter className="size-3.5" strokeWidth={1.75} aria-hidden />
            {t('filter')}
            {active > 0 && (
              <span className="rounded-full bg-primary/15 px-1.5 text-[11px] tabular-nums text-foreground">
                {active}
              </span>
            )}
          </button>
        )}
      >
        <FilterPanel facets={facets} filters={filters} onToggle={onToggle} />
      </DropdownMenu>

      <FilterTokens facets={facets} filters={filters} onToggle={onToggle} onClear={onClear} />
    </div>
  )
}

function FilterPanel({
  facets,
  filters,
  onToggle,
}: {
  facets: FacetSpec[]
  filters: ListFilters
  onToggle: (facet: string, value: string) => void
}) {
  const t = useTranslations('listView')
  const close = useDropdownClose()
  // 두 단계 메뉴의 현재 자리. 값을 고른 뒤에도 이 자리에 남는다 — 라벨 세 개를 걸려고 메뉴를 세 번 여는
  // 것은 필터 메뉴가 아니라 필터 대화상자다.
  const [facetKey, setFacetKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const facet = facets.find((candidate) => candidate.key === facetKey)

  if (facet === undefined)
    return (
      <>
        <DropdownLabel>{t('filterBy')}</DropdownLabel>
        {facets.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => {
              setFacetKey(option.key)
              setQuery('')
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent"
          >
            <span className="flex-1 truncate">{option.label}</span>
            {(filters[option.key]?.length ?? 0) > 0 && (
              <span className="rounded-full bg-secondary px-1.5 text-[11px] tabular-nums text-muted-foreground">
                {filters[option.key]?.length}
              </span>
            )}
          </button>
        ))}
      </>
    )

  const needle = query.trim().toLocaleLowerCase()
  const options = facet.options.filter(
    (option) => needle === '' || option.label.toLocaleLowerCase().includes(needle)
  )
  const selected = filters[facet.key] ?? []

  return (
    <>
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          onClick={() => setFacetKey(null)}
          aria-label={t('filterBack')}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </button>
        <span className="flex-1 truncate text-[11px] font-[510] uppercase tracking-wide text-faint">
          {facet.label}
        </span>
      </div>
      <div className="px-1 pb-1">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('filterSearchPlaceholder')}
          autoFocus
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {options.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">{t('filterNoMatch')}</p>
        ) : (
          options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onToggle(facet.key, option.value)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent"
            >
              {option.icon}
              <span className="flex-1 truncate">{option.label}</span>
              {selected.includes(option.value) && (
                <Check className="size-3.5 text-muted-foreground" />
              )}
            </button>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={close}
        className="mt-1 w-full rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {t('filterDone')}
      </button>
    </>
  )
}

// 지금 걸려 있는 것들 — 하나씩 뗄 수 있는 토큰. 메뉴 밖에 서는 이유는 위 주석과 같다.
function FilterTokens({
  facets,
  filters,
  onToggle,
  onClear,
}: {
  facets: FacetSpec[]
  filters: ListFilters
  onToggle: (facet: string, value: string) => void
  onClear: () => void
}) {
  const t = useTranslations('listView')
  if (listFilterCount(filters) === 0) return null

  return (
    <>
      {facets.flatMap((facet) => {
        const values = filters[facet.key] ?? []
        return values.map((value) => {
          // 지워진 프로젝트를 가리키는 필터처럼 이름을 못 찾는 값은 값 자체를 보여 준다 — 빈 칩보다 낫다.
          const label = facet.options.find((option) => option.value === value)?.label ?? value
          return (
            <span
              key={`${facet.key}:${value}`}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-2 pr-1 text-[11.5px] text-foreground"
            >
              <span className="text-muted-foreground">{facet.label}</span>
              <span className="truncate">{label}</span>
              <button
                type="button"
                onClick={() => onToggle(facet.key, value)}
                aria-label={t('filterRemove', { name: label })}
                className="rounded-full p-0.5 transition-colors hover:bg-accent"
              >
                <X className="size-3" />
              </button>
            </span>
          )
        })
      })}
      <button
        type="button"
        onClick={onClear}
        className={cn(
          'rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground',
          'hover:bg-accent hover:text-foreground'
        )}
      >
        {t('filterClear')}
      </button>
    </>
  )
}
