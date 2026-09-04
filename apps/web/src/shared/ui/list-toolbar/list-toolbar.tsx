'use client'

import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { ListDisplay, ListFilters } from '@/shared/lib/list-view'
import { Input } from '@/shared/ui/input'

import { FacetFilterMenu, type FacetSpec } from './facet-filter-menu'
import { ListDisplayMenu } from './list-display-menu'

// One line on a list screen — the left is **what to look at** (search + filters) and the right is **how to look at it** (the count + display).
// It exists so the four evaluation resource lists use a line identical down to the last character, and it is the same arrangement as the issue list's toolbar.
//
// The grouping and ordering names come from the shared vocabulary (`listView.groupBy` / `listView.orderBy`): there is no reason for "team" to be
// called by a different word on the harness list and the scorecard list.
export function ListToolbar({
  search,
  onSearch,
  facets,
  filters,
  onToggleFilter,
  onClearFilters,
  total,
  groupings,
  orders,
  display,
  onDisplay,
}: {
  search: string
  onSearch: (value: string) => void
  facets: FacetSpec[]
  filters: ListFilters
  onToggleFilter: (facet: string, value: string) => void
  onClearFilters: () => void
  total: number
  groupings: readonly string[]
  orders: readonly string[]
  display: ListDisplay
  onDisplay: (next: Partial<ListDisplay>) => void
}) {
  const t = useTranslations('listView')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[180px] max-w-[280px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchAria')}
          className="pl-8"
        />
      </div>
      <FacetFilterMenu
        facets={facets}
        filters={filters}
        onToggle={onToggleFilter}
        onClear={onClearFilters}
      />
      <div className="ml-auto flex items-center gap-2">
        <span className="text-[12px] tabular-nums text-muted-foreground">
          {t('totalCount', { count: total })}
        </span>
        <ListDisplayMenu
          groupings={groupings.map((value) => ({ value, label: t(`groupBy.${value}`) }))}
          grouping={display.grouping}
          onGrouping={(grouping) => onDisplay({ grouping })}
          orders={orders.map((value) => ({ value, label: t(`orderBy.${value}`) }))}
          order={display.order}
          onOrder={(order) => onDisplay({ order })}
        />
      </div>
    </div>
  )
}
