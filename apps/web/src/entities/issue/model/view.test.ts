import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ISSUE_VIEW,
  issueFilterCount,
  issueGroupsToRender,
  issueQueryFilters,
  issueViewHref,
  issueViewOf,
  orderIssueGroups,
  toggleIssueFilter,
  type IssueView,
} from './view'

const view = (over: Partial<IssueView> = {}): IssueView => ({ ...DEFAULT_ISSUE_VIEW, ...over })

describe('issue view — the URL is the screen', () => {
  it('round-trips a view through the query string and leaves defaults out of the address', () => {
    const configured = view({
      grouping: 'assignee',
      order: 'priority',
      layout: 'board',
      showCompleted: true,
      filters: { status: ['todo'], label: ['bug', 'flaky'] },
    })
    const href = issueViewHref('/acme/teams/ENG', configured)
    expect(issueViewOf(Object.fromEntries(new URL(href, 'https://x').searchParams))).toMatchObject({
      grouping: 'assignee',
      order: 'priority',
      layout: 'board',
      showCompleted: true,
    })
    // A default never appears in the address: the URL stays readable, and changing a default later does not
    // leave old links pinned to the value it used to have.
    expect(issueViewHref('/acme/teams/ENG', view())).toBe('/acme/teams/ENG')
  })

  it('reads a repeated key as a set, and drops values the vocabulary does not have', () => {
    const parsed = issueViewOf({ status: ['todo', 'nonsense', 'done'], priority: 'urgent' })
    expect(parsed.filters.status).toEqual(['todo', 'done'])
    expect(parsed.filters.priority).toEqual(['urgent'])
    expect(issueFilterCount(parsed.filters)).toBe(3)
  })

  it('never leaves a board with nothing to draw', () => {
    // Columns ARE the groups, so an ungrouped board has no shape — it normalizes to the status board rather
    // than rendering an empty screen from an address a member can perfectly well type.
    expect(issueViewOf({ layout: 'board', group: 'none' }).grouping).toBe('status')
    expect(issueViewOf({ group: 'none' }).grouping).toBe('none')
  })

  it('turns "hide completed" into the status set the control plane understands — unless statuses were chosen', () => {
    expect(issueQueryFilters(view()).status).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'regressed',
    ])
    expect(issueQueryFilters(view({ showCompleted: true })).status).toBeUndefined()
    // An explicit choice wins over the toggle: picking `done` and still being served open issues would be the
    // screen overruling the member.
    expect(issueQueryFilters(view({ filters: { status: ['done'] } })).status).toEqual(['done'])
  })

  it('toggling the last value off removes the facet instead of filtering to nothing', () => {
    const one = toggleIssueFilter({}, 'label', 'bug')
    expect(one).toEqual({ label: ['bug'] })
    // An empty array would mean "chosen, and nothing matches" — the list would go blank rather than unfiltered.
    expect(toggleIssueFilter(one, 'label', 'bug')).toEqual({})
  })
})

describe('issue groups — what the screen actually stands up', () => {
  it('orders status groups by the workflow, not by size, and keeps the unset bucket last', () => {
    const ordered = orderIssueGroups(
      [
        { key: 'backlog', count: 9 },
        { key: 'in_progress', count: 1 },
        { key: 'todo', count: 4 },
      ],
      'status'
    )
    expect(ordered.map((g) => g.key)).toEqual(['in_progress', 'todo', 'backlog'])
    // An open vocabulary has no order of its own, so the control plane's largest-first survives untouched.
    const byAssignee = [
      { key: 'dana', count: 3 },
      { key: null, count: 1 },
    ]
    expect(orderIssueGroups(byAssignee, 'assignee')).toEqual(byAssignee)
  })

  it('stands up an EMPTY status column, because a board needs somewhere to drop a card', () => {
    const columns = issueGroupsToRender([{ key: 'todo', count: 2 }], 'status', view())
    expect(columns).toContainEqual({ key: 'in_progress', count: 0 })
    // …but not the columns the "hide completed" toggle just switched off.
    expect(columns.map((c) => c.key)).not.toContain('done')
    expect(issueGroupsToRender([], 'status', view({ showCompleted: true })).map((c) => c.key)).toContain(
      'done'
    )
  })

  it('does not invent a column per member — an open vocabulary shows only the groups that hold issues', () => {
    expect(issueGroupsToRender([{ key: 'dana', count: 2 }], 'assignee', view())).toEqual([
      { key: 'dana', count: 2 },
    ])
  })
})
