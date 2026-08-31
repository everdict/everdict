import type { ListDisplay, ListViewSpec } from '@/shared/lib/list-view'

import type { ScorecardRow } from './list-row'

// 배치 평가 목록의 어휘. 다른 셋과 다른 점이 둘 있다.
//
// ① 상태가 닫힌 어휘라 그룹 순서가 정해져 있다 — 실행 중인 것이 끝난 것 위에 서야 이 화면이 "지금 무슨 일이
//    벌어지고 있나"에 먼저 답한다. ② 「실행한 날」로 묶을 수 있다: 스코어카드는 사건이라, 사람들이 실제로
//    묻는 것은 "어제 무엇이 돌았나"이다.
export const SCORECARD_FACETS = [
  'team',
  'status',
  'harness',
  'dataset',
  'runtime',
  'creator',
] as const
export const SCORECARD_GROUPINGS = [
  'none',
  'status',
  'day',
  'harness',
  'dataset',
  'team',
  'creator',
] as const
export const SCORECARD_ORDERS = ['recent', 'name'] as const

export const DEFAULT_SCORECARD_DISPLAY: ListDisplay = { grouping: 'day', order: 'recent' }

// 상태 그룹의 순서 — 어휘 자체가 순서다.
const STATUS_ORDER = ['running', 'queued', 'failed', 'succeeded', 'cancelled', 'superseded']

// 그 배치가 돈 날(로컬 달력 날짜가 아니라 ISO 날짜) — 묶기 전용 키다.
function dayOf(record: ScorecardRow): string {
  return record.createdAt.slice(0, 10)
}

export const scorecardListSpec: ListViewSpec<ScorecardRow> = {
  facetValues: (record, facet) => {
    switch (facet) {
      case 'team':
        return record.teamId === undefined ? [] : [record.teamId]
      case 'status':
        return [record.status]
      case 'harness':
        return [record.harness.id]
      case 'dataset':
        return [record.dataset.id]
      case 'runtime':
        return record.runtime === undefined ? [] : [record.runtime]
      case 'creator':
        return record.createdBy === undefined ? [] : [record.createdBy]
      default:
        return []
    }
  },
  searchText: (record) => [record.id, record.harness.id, record.dataset.id].join(' '),
  groupKey: (record, grouping) => {
    switch (grouping) {
      case 'status':
        return record.status
      case 'day':
        return dayOf(record)
      case 'harness':
        return record.harness.id
      case 'dataset':
        return record.dataset.id
      case 'team':
        return record.teamId ?? null
      case 'creator':
        return record.createdBy ?? null
      default:
        return null
    }
  },
  compare: (a, b, order) =>
    order === 'name'
      ? `${a.harness.id} ${a.dataset.id}`.localeCompare(`${b.harness.id} ${b.dataset.id}`)
      : b.createdAt.localeCompare(a.createdAt),
  // 날짜는 큰 그룹 먼저가 아니라 **최근 먼저**다 — 어제가 지난달 아래에 서면 그건 목록이 아니다.
  groupOrder: (grouping) =>
    grouping === 'status'
      ? STATUS_ORDER
      : grouping === 'day'
        ? (a: string, b: string) => b.localeCompare(a)
        : undefined,
}
