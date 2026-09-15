import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ISSUE_DISPLAY,
  issueDisplayFor,
  withIssueDisplay,
  WORKSPACE_ISSUES_VIEW_KEY,
  type IssueDisplay,
} from './display'

const display = (over: Partial<IssueDisplay> = {}): IssueDisplay => ({
  ...DEFAULT_ISSUE_DISPLAY,
  ...over,
})

describe('issue display — the reader’s preference, remembered per view', () => {
  it('round-trips a choice through the cookie', () => {
    const cookie = withIssueDisplay(
      undefined,
      'project:alpha:issues',
      display({
        grouping: 'assignee',
        order: 'priority',
        layout: 'board',
        showCompleted: true,
        subIssues: 'top',
      })
    )
    expect(issueDisplayFor(cookie, 'project:alpha:issues')).toEqual({
      grouping: 'assignee',
      order: 'priority',
      layout: 'board',
      showCompleted: true,
      subIssues: 'top',
    })
  })

  it('keeps each view’s choice apart, so a project board does not re-shape the issue list', () => {
    // The whole reason the preference is keyed: a board layout chosen for one screen must not follow the
    // reader into another list, which is the annoyance per-view memory exists to prevent.
    let cookie = withIssueDisplay(undefined, 'project:alpha:board', display({ layout: 'board' }))
    cookie = withIssueDisplay(cookie, 'project:alpha:issues', display({ order: 'created' }))
    expect(issueDisplayFor(cookie, 'project:alpha:board').layout).toBe('board')
    expect(issueDisplayFor(cookie, 'project:alpha:issues').layout).toBe('list')
    // A view nobody has configured answers with the defaults rather than someone else's screen.
    expect(issueDisplayFor(cookie, 'workspace:issues')).toEqual(DEFAULT_ISSUE_DISPLAY)
  })

  it('falls back per field when the stored word is no longer in the vocabulary', () => {
    // The cookie outlives the code that wrote it. One renamed grouping must cost that grouping, not the whole
    // preference — the reader keeps the ordering and layout they chose.
    const stale = 'project%3Aalpha%3Aissues=byMoonPhase-priority-board-1-top'
    expect(issueDisplayFor(stale, 'project:alpha:issues')).toEqual({
      grouping: 'status',
      order: 'priority',
      layout: 'board',
      showCompleted: true,
      subIssues: 'top',
    })
  })

  it('never stores a board with nothing to draw', () => {
    // Columns ARE the groups, so an ungrouped board has no shape. Normalising on the way in means no stored
    // preference can produce an empty screen.
    const cookie = withIssueDisplay(
      undefined,
      'issues',
      display({ layout: 'board', grouping: 'none' })
    )
    expect(issueDisplayFor(cookie, 'issues').grouping).toBe('status')
  })

  it('remembers a bounded number of views, dropping the least recently changed', () => {
    // A cookie rides every request, so this cannot grow forever. The evicted view reverts to the defaults, which
    // is a smaller loss than an unbounded header.
    let cookie = withIssueDisplay(undefined, 'first:view', display({ order: 'created' }))
    for (let i = 0; i < 12; i += 1) {
      cookie = withIssueDisplay(cookie, `view:${i}`, display({ order: 'due' }))
    }
    expect(issueDisplayFor(cookie, 'first:view')).toEqual(DEFAULT_ISSUE_DISPLAY)
    expect(issueDisplayFor(cookie, 'view:11').order).toBe('due')
  })

  it("keeps one view's preference out of another's — the whole point of a per-view store", () => {
    // Given: two views configured differently
    let cookie = withIssueDisplay(
      undefined,
      WORKSPACE_ISSUES_VIEW_KEY,
      display({ layout: 'board' })
    )
    cookie = withIssueDisplay(cookie, 'other:view', display({ layout: 'list' }))

    // Then: each keeps its own. Carrying one screen's layout onto another is the annoyance this exists to stop.
    expect(issueDisplayFor(cookie, WORKSPACE_ISSUES_VIEW_KEY).layout).toBe('board')
    expect(issueDisplayFor(cookie, 'other:view').layout).toBe('list')
  })
})
