'use client'

import { useState, type ReactNode } from 'react'
import { ArrowLeft, Check, ListFilter, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { listFilterCount, type ListFilters } from '@/shared/lib/list-view'
import { cn } from '@/shared/lib/utils'
import { DropdownLabel, DropdownMenu, useDropdownClose } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

// "Filter" — Linear's two-step menu (pick an axis → pick values). Applied filters stand as TOKENS in the toolbar rather than inside the menu,
// and each token carries its own remove button: having to reopen a menu to see what is applied means it is hidden.
//
// This component does not know which resource's list it is on — the axes and values arrive as `facets`, and toggling is `onToggle`'s job.
// It exists so the issue list and the evaluation resource lists use the **same** filter UI, which is what stops one of them from looking
// different.

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
  // The two-step menu's current position. It STAYS here after a value is picked — opening the menu three times to attach three labels is a
  // filter dialog rather than a filter menu.
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

// What is applied right now — tokens that can be removed one at a time. They stand outside the menu for the reason in the comment above.
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
          // A value whose name cannot be found (a filter pointing at a deleted project, say) shows the value itself — better than an empty chip.
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
