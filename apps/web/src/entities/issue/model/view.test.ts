import { describe, expect, it } from 'vitest'

import { DEFAULT_ISSUE_DISPLAY } from './display'
import {
  issueFilterCount,
  issueGroupsToRender,
  issueQueryFilters,
  issueViewHref,
  issueViewOf,
  orderIssueGroups,
  toggleIssueFilter,
  type IssueView,
} from './view'

const view = (over: Partial<IssueView> = {}): IssueView => ({
  ...DEFAULT_ISSUE_DISPLAY,
  filters: {},
  ...over,
})

describe('issue view — the URL carries the filters, and only the filters', () => {
  it('round-trips the filters through the query string', () => {
    const href = issueViewHref(
      '/acme/team/ENG',
      view({ filters: { status: ['todo'], label: ['bug', 'flaky'] } })
    )
    const parsed = issueViewOf(
      Object.fromEntries(new URL(href, 'https://x').searchParams),
      DEFAULT_ISSUE_DISPLAY
    )
    expect(parsed.filters.status).toEqual(['todo'])
    expect(issueViewHref('/acme/team/ENG', view())).toBe('/acme/team/ENG')
  })

  it('never writes the display into the address — a shared link must not re-arrange the reader’s screen', () => {
    // Grouping, ordering and layout are the READER's, stored per user. Putting them in the URL is how a pasted
    // link ends up imposing the sender's board on someone who wanted their list.
    const href = issueViewHref(
      '/acme/team/ENG',
      view({
        grouping: 'assignee',
        order: 'priority',
        layout: 'board',
        showCompleted: true,
        subIssues: 'top',
      })
    )
    expect(href).toBe('/acme/team/ENG')
  })

  it('takes the display from the reader, not from whatever the address happens to say', () => {
    // The old display parameters are now just unknown words in the query: they are ignored rather than obeyed,
    // so a link someone saved before the split cannot override the recipient's preference.
    const savedBeforeTheSplit = Object.fromEntries(new URLSearchParams('group=cycle&layout=board'))
    const parsed = issueViewOf(savedBeforeTheSplit, {
      ...DEFAULT_ISSUE_DISPLAY,
      grouping: 'assignee',
    })
    expect(parsed.grouping).toBe('assignee')
    expect(parsed.layout).toBe('list')
  })

  it('reads a repeated key as a set, and drops values the vocabulary does not have', () => {
    const parsed = issueViewOf(
      { status: ['todo', 'nonsense', 'done'], priority: 'urgent' },
      DEFAULT_ISSUE_DISPLAY
    )
    expect(parsed.filters.status).toEqual(['todo', 'done'])
    expect(parsed.filters.priority).toEqual(['urgent'])
    expect(issueFilterCount(parsed.filters)).toBe(3)
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
    expect(
      issueGroupsToRender([], 'status', view({ showCompleted: true })).map((c) => c.key)
    ).toContain('done')
  })

  it('does not invent a column per member — an open vocabulary shows only the groups that hold issues', () => {
    expect(issueGroupsToRender([{ key: 'dana', count: 2 }], 'assignee', view())).toEqual([
      { key: 'dana', count: 2 },
    ])
  })
})
