import type { ListDisplay, ListViewSpec } from '@/shared/lib/list-view'

import type { JudgeSummary } from './schema'

// 저지 목록의 어휘. 「출처」(owner)가 축인 이유는 이 목록이 워크스페이스가 만든 것과 기본 제공(`_shared`)을
// 함께 보여 주는 유일한 평가 자원 목록이기 때문이다 — 하네스·데이터셋은 자기 워크스페이스 것만 남긴다.
export const JUDGE_FACETS = ['owner', 'creator'] as const
export const JUDGE_GROUPINGS = ['none', 'owner', 'creator'] as const
export const JUDGE_ORDERS = ['name', 'updated', 'created', 'versions'] as const

export const DEFAULT_JUDGE_DISPLAY: ListDisplay = { grouping: 'none', order: 'name' }

// `_shared` 는 제어 평면이 정한 이름이다 — 워크스페이스 이름이 무엇이든 이것만 기본 제공을 뜻한다.
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
