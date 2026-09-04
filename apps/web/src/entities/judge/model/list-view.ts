import type { ListDisplay, ListViewSpec } from '@/shared/lib/list-view'

import type { JudgeSummary } from './schema'

// The judge list's vocabulary. "Source" (owner) is an axis because this is the only evaluation resource list that shows what the workspace made
// TOGETHER with the built-in defaults (`_shared`) — the harness and dataset lists keep only their own workspace's.
export const JUDGE_FACETS = ['owner', 'creator'] as const
export const JUDGE_GROUPINGS = ['none', 'owner', 'creator'] as const
export const JUDGE_ORDERS = ['name', 'updated', 'created', 'versions'] as const

export const DEFAULT_JUDGE_DISPLAY: ListDisplay = { grouping: 'none', order: 'name' }

// `_shared` is a name the control plane decided — whatever the workspace is called, only this means "built in".
export const SHARED_OWNER = '_shared'

export const judgeListSpec: ListViewSpec<JudgeSummary> = {
  facetValues: (judge, facet) => {
    switch (facet) {
      case 'owner':
        return [judge.owner]
      case 'creator':
        return judge.createdBy === undefined ? [] : [judge.createdBy]
      default:
        return []
    }
  },
  searchText: (judge) => judge.id,
  groupKey: (judge, grouping) => {
    switch (grouping) {
      case 'owner':
        return judge.owner
      case 'creator':
        return judge.createdBy ?? null
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
      case 'versions':
        return b.versions.length - a.versions.length
      default:
        return a.id.localeCompare(b.id)
    }
  },
}
