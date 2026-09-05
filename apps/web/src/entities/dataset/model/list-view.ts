import type { ListDisplay, ListViewSpec } from '@/shared/lib/list-view'

import type { DatasetSummary } from './schema'

// The dataset list's vocabulary — the same grammar as the harness's (see `entities/harness/model/list-view.ts`).
// A dataset can hold several tags, so they are used for **filtering** only and never for grouping: grouped, the groups would sum to more than
// the list and the header's number would be a lie.
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
