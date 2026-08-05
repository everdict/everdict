'use client'

import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { ListDisplay, ListFilters } from '@/shared/lib/list-view'
import { Input } from '@/shared/ui/input'

import { FacetFilterMenu, type FacetSpec } from './facet-filter-menu'
import { ListDisplayMenu } from './list-display-menu'

// 목록 화면의 한 줄 — 왼쪽은 **무엇을 볼 것인가**(검색 + 필터), 오른쪽은 **어떻게 볼 것인가**(개수 + 표시).
// 네 평가 자원 목록이 글자 하나까지 같은 줄을 쓰기 위한 것이고, 이슈 목록의 툴바와도 같은 배치다.
//
// 묶기·정렬의 이름은 공용 어휘(`listView.groupBy` / `listView.orderBy`)에서 온다: 「팀」이 하네스 목록과
// 스코어카드 목록에서 다른 단어로 불릴 이유가 없다.
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
