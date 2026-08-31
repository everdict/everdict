import { describe, expect, it } from 'vitest'

import { applyListView } from '@/shared/lib/list-view'

import {
  caseFailedBy,
  caseVerdictKey,
  DEFAULT_CASE_DISPLAY,
  scorecardCaseListSpec,
  type ScorecardCaseFacts,
} from './case-list-view'

const score = (graderId: string, metric: string, pass?: boolean) => ({ graderId, metric, pass })

const cases: ScorecardCaseFacts[] = [
  {
    caseId: 'alpha',
    verdict: true,
    // A passing case with one non-authoritative metric failing — the verdict already decided not to count it.
    scores: [score('tests', 'pass', true), score('judge', 'judge:style', false)],
    taskSummary: 'install the package',
    tags: ['smoke'],
    envKind: 'repo',
  },
  {
    caseId: 'bravo',
    verdict: false,
    scores: [score('tests', 'pass', false), score('judge', 'judge:style', false)],
    errorSummary: 'ENOSPC: no space left on device',
    tags: ['smoke', 'nightly'],
    envKind: 'repo',
  },
  {
    caseId: 'charlie',
    scores: [score('tests', 'pass')],
    taskSummary: 'open the dashboard',
    tags: [],
  },
  {
    caseId: 'delta',
    verdict: false,
    scores: [score('judge', 'judge:style', false)],
    taskSummary: 'rename the column',
    tags: ['nightly'],
    envKind: 'browser',
  },
]

const view = (over: Partial<Parameters<typeof applyListView<ScorecardCaseFacts>>[1]> = {}) => ({
  filters: {},
  search: '',
  display: DEFAULT_CASE_DISPLAY,
  ...over,
})

const apply = (over: Parameters<typeof view>[0] = {}) =>
  applyListView(cases, view(over), scorecardCaseListSpec)

const idsOf = (groups: { items: ScorecardCaseFacts[] }[]) =>
  groups.flatMap((group) => group.items.map((item) => item.caseId))

describe('case verdict — a case with no verdict is a third value, not a pass', () => {
  it('names the three buckets', () => {
    expect(caseVerdictKey(true)).toBe('pass')
    expect(caseVerdictKey(false)).toBe('fail')
    expect(caseVerdictKey(undefined)).toBe('skip')
  })
})

describe('"failed by" — only what the verdict actually counted', () => {
  it('lists every failing metric of a failed case', () => {
    expect(caseFailedBy(cases[1] as ScorecardCaseFacts)).toEqual([
      'tests:pass',
      'judge:judge:style',
    ])
  })

  // Counting a failing metric inside a passing case would make this filter say something different from the
  // verdict — you filter by "what failed a case" and PASS rows come along.
  it('says nothing about a case the verdict passed, even when a metric failed', () => {
    expect(caseFailedBy(cases[0] as ScorecardCaseFacts)).toEqual([])
  })

  it('says nothing about a case with no verdict at all', () => {
    expect(caseFailedBy(cases[2] as ScorecardCaseFacts)).toEqual([])
  })
})

describe('case list view — the axes people actually reach for on a batch of hundreds', () => {
  it('orders failures first, then unverdicted, then passes', () => {
    expect(idsOf(apply().groups)).toEqual(['bravo', 'delta', 'charlie', 'alpha'])
  })

  it('orders by case id when asked, keeping a case trials together in run order', () => {
    const trials: ScorecardCaseFacts[] = [
      { caseId: 'alpha', trial: 2, verdict: true, scores: [] },
      { caseId: 'alpha', trial: 1, verdict: false, scores: [] },
      { caseId: 'beta', trial: 1, verdict: true, scores: [] },
    ]
    const { groups } = applyListView(
      trials,
      view({ display: { grouping: 'none', order: 'caseId' } }),
      scorecardCaseListSpec
    )
    expect(groups[0]?.items.map((item) => `${item.caseId}#${item.trial}`)).toEqual([
      'alpha#1',
      'alpha#2',
      'beta#1',
    ])
  })

  it('filters to the failures — the one thing this list is asked for most', () => {
    expect(idsOf(apply({ filters: { verdict: ['fail'] } }).groups)).toEqual(['bravo', 'delta'])
  })

  it('filters by what failed the case', () => {
    expect(idsOf(apply({ filters: { failedBy: ['tests:pass'] } }).groups)).toEqual(['bravo'])
  })

  it('filters by a dataset tag', () => {
    expect(idsOf(apply({ filters: { tag: ['nightly'] } }).groups)).toEqual(['bravo', 'delta'])
  })

  // A case with no tags at all filters as the "no tag" bucket (the empty string is its name).
  it('filters the untagged cases as their own bucket', () => {
    expect(idsOf(apply({ filters: { tag: [''] } }).groups)).toEqual(['charlie'])
  })

  it('searches the case id, the task line, the error line and the metric names', () => {
    expect(idsOf(apply({ search: 'ENOSPC' }).groups)).toEqual(['bravo'])
    expect(idsOf(apply({ search: 'dashboard' }).groups)).toEqual(['charlie'])
    expect(idsOf(apply({ search: 'judge:style' }).groups)).toEqual(['bravo', 'delta', 'alpha'])
  })

  it('groups by verdict with failures standing above passes', () => {
    const { groups } = apply({ display: { grouping: 'verdict', order: 'failuresFirst' } })
    expect(groups.map((group) => group.key)).toEqual(['fail', 'skip', 'pass'])
    expect(groups.map((group) => group.items.length)).toEqual([2, 1, 1])
  })
})
