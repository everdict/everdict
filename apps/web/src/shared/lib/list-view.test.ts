import { describe, expect, it } from 'vitest'

import {
  applyListView,
  listDisplayFor,
  listFilterCount,
  listFiltersOf,
  listViewQuery,
  toggleListFilter,
  withListDisplay,
  type ListViewSpec,
} from './list-view'

interface Row {
  id: string
  team: string | undefined
  tags: string[]
  updatedAt: string
}

const spec: ListViewSpec<Row> = {
  facetValues: (row, facet) =>
    facet === 'team' ? (row.team === undefined ? [] : [row.team]) : row.tags,
  searchText: (row) => row.id,
  groupKey: (row, grouping) => (grouping === 'team' ? (row.team ?? null) : null),
  compare: (a, b, order) =>
    order === 'name' ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt),
}

const rows: Row[] = [
  { id: 'alpha', team: 'eng', tags: ['smoke'], updatedAt: '2026-08-01' },
  { id: 'bravo', team: 'eng', tags: ['smoke', 'nightly'], updatedAt: '2026-08-03' },
  { id: 'charlie', team: 'des', tags: [], updatedAt: '2026-08-02' },
  { id: 'delta', team: undefined, tags: ['nightly'], updatedAt: '2026-08-04' },
]

const view = (over: Partial<Parameters<typeof applyListView<Row>>[1]> = {}) => ({
  filters: {},
  search: '',
  display: { grouping: 'none', order: 'updated' },
  ...over,
})

describe('list filters — a facet is "any of these", and an empty one is no facet at all', () => {
  it('turns a value on and off, dropping the facet when the last value goes', () => {
    const one = toggleListFilter({}, 'team', 'eng')
    expect(one).toEqual({ team: ['eng'] })
    const two = toggleListFilter(one, 'team', 'des')
    expect(two.team).toEqual(['eng', 'des'])
    expect(toggleListFilter(toggleListFilter(two, 'team', 'des'), 'team', 'eng')).toEqual({})
  })

  it('counts every selected value across facets', () => {
    expect(listFilterCount({ team: ['eng', 'des'], tags: ['smoke'] })).toBe(3)
  })

  // 주소창에는 무엇이든 칠 수 있다 — 모르는 축은 400 을 만드는 대신 버린다.
  it('reads only the facets this list knows about', () => {
    expect(listFiltersOf({ team: 'eng', nonsense: 'x' }, ['team', 'tags'])).toEqual({
      team: ['eng'],
    })
    expect(listFiltersOf({ team: ['eng', 'des'] }, ['team'])).toEqual({ team: ['eng', 'des'] })
  })

  it('spells a set as a repeated parameter, and carries the search text as q', () => {
    expect(listViewQuery({ team: ['eng', 'des'] }, ['team'], 'alp').toString()).toBe(
      'team=eng&team=des&q=alp'
    )
    expect(listViewQuery({}, ['team'], '').toString()).toBe('')
  })
})

describe('applyListView — filtering, searching, ordering and grouping in one pass', () => {
  it('keeps an item when it matches ANY value of every filtered facet', () => {
    const { groups, total } = applyListView(rows, view({ filters: { team: ['eng'] } }), spec)
    expect(total).toBe(2)
    expect(groups[0]?.items.map((r) => r.id)).toEqual(['bravo', 'alpha'])
  })

  // 값이 하나도 없는 항목은 「미지정」으로 걸러질 수 있어야 한다 — 사람들이 실제로 찾는 버킷이다.
  it('lets an item with no value on a facet be filtered as unset', () => {
    const { groups } = applyListView(rows, view({ filters: { team: [''] } }), spec)
    expect(groups[0]?.items.map((r) => r.id)).toEqual(['delta'])
  })

  it('intersects across facets and unions within one', () => {
    const { total } = applyListView(
      rows,
      view({ filters: { team: ['eng'], tags: ['nightly'] } }),
      spec
    )
    expect(total).toBe(1)
  })

  it('searches the text the list decided is searchable', () => {
    const { total } = applyListView(rows, view({ search: ' CHAR ' }), spec)
    expect(total).toBe(1)
  })

  it('orders by the chosen key', () => {
    const { groups } = applyListView(
      rows,
      view({ display: { grouping: 'none', order: 'name' } }),
      spec
    )
    expect(groups[0]?.items.map((r) => r.id)).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
  })

  // 이름 없는 그룹이 이름 있는 것들 사이에 끼면 목록이 아니라 잔해로 읽힌다.
  it('puts the biggest group first and the unset bucket last', () => {
    const { groups } = applyListView(
      rows,
      view({ display: { grouping: 'team', order: 'updated' } }),
      spec
    )
    expect(groups.map((g) => g.key)).toEqual(['eng', 'des', null])
    expect(groups.map((g) => g.items.length)).toEqual([2, 1, 1])
  })

  it('follows a closed vocabulary’s own order when the list declares one', () => {
    const ordered = { ...spec, groupOrder: () => ['des', 'eng'] as const }
    const { groups } = applyListView(
      rows,
      view({ display: { grouping: 'team', order: 'updated' } }),
      ordered
    )
    expect(groups.map((g) => g.key)).toEqual(['des', 'eng', null])
  })
})

describe('the display cookie — per reader, per view, and never trusted', () => {
  const vocabulary = {
    groupings: ['none', 'team'],
    orders: ['updated', 'name'],
    fallback: { grouping: 'none', order: 'updated' },
  }

  it('remembers one view’s choice without touching another’s', () => {
    const cookie = withListDisplay(
      withListDisplay(undefined, 'harnesses', { grouping: 'team', order: 'name' }),
      'datasets',
      { grouping: 'none', order: 'updated' }
    )
    expect(listDisplayFor(cookie, 'harnesses', vocabulary)).toEqual({
      grouping: 'team',
      order: 'name',
    })
    expect(listDisplayFor(cookie, 'judges', vocabulary)).toEqual(vocabulary.fallback)
  })

  // 쿠키 아래에서 어휘가 바뀔 수 있다 — 낡은 단어 하나는 그 단어만큼만 잃어야지, 취향 전체를 버리면 안 된다.
  it('falls back field by field when a stored word is no longer a word', () => {
    const cookie = withListDisplay(undefined, 'harnesses', { grouping: 'retired', order: 'name' })
    expect(listDisplayFor(cookie, 'harnesses', vocabulary)).toEqual({
      grouping: 'none',
      order: 'name',
    })
  })

  it('evicts the least recently changed view rather than growing without bound', () => {
    let cookie = ''
    for (let i = 0; i < 14; i += 1) {
      cookie = withListDisplay(cookie, `view-${i}`, { grouping: 'team', order: 'name' })
    }
    expect(listDisplayFor(cookie, 'view-13', vocabulary).grouping).toBe('team')
    expect(listDisplayFor(cookie, 'view-0', vocabulary)).toEqual(vocabulary.fallback)
  })
})
