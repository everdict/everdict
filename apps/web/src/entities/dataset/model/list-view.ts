import type { ListDisplay, ListViewSpec } from '@/shared/lib/list-view'

import type { DatasetSummary } from './schema'

// 데이터셋 목록의 어휘 — 하네스와 같은 문법이다(`entities/harness/model/list-view.ts` 참고).
// 태그는 한 데이터셋이 여럿 들 수 있으므로 **거르기**에만 쓰고 묶기에는 쓰지 않는다: 묶으면 그룹 합이
// 목록보다 커져 헤더의 숫자가 거짓말을 한다.
export const DATASET_FACETS = ['creator', 'tag'] as const
export const DATASET_GROUPINGS = ['none', 'creator'] as const
export const DATASET_ORDERS = ['name', 'updated', 'created', 'cases'] as const

export const DEFAULT_DATASET_DISPLAY: ListDisplay = { grouping: 'none', order: 'name' }

export const datasetListSpec: ListViewSpec<DatasetSummary> = {
  facetValues: (dataset, facet) => {
    switch (facet) {
      case 'creator':
        return dataset.createdBy === undefined ? [] : [dataset.createdBy]
      case 'tag':
        return dataset.tags
      default:
        return []
    }
  },
  searchText: (dataset) => [dataset.id, dataset.description ?? '', ...dataset.tags].join(' '),
  groupKey: (dataset, grouping) => {
    switch (grouping) {
      case 'creator':
        return dataset.createdBy ?? null
      default:
        return null
    }
  },
  compare: (a, b, order) => {
    switch (order) {
      case 'updated':
        return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
      case 'created':
        return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
      case 'cases':
        return (b.caseCount ?? 0) - (a.caseCount ?? 0)
      default:
        return a.id.localeCompare(b.id)
    }
  },
}
