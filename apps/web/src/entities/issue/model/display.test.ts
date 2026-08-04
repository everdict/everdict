import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ISSUE_DISPLAY,
  issueDisplayFor,
  issueViewKeyOf,
  withIssueDisplay,
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
      'team:ENG:issues',
      display({
        grouping: 'assignee',
        order: 'priority',
        layout: 'board',
        showCompleted: true,
        subIssues: 'top',
      })
    )
    expect(issueDisplayFor(cookie, 'team:ENG:issues')).toEqual({
      grouping: 'assignee',
      order: 'priority',
      layout: 'board',
      showCompleted: true,
      subIssues: 'top',
    })
  })

  it('keeps each view’s choice apart, so a cycle board does not re-shape the issue list', () => {
    // The whole reason the preference is keyed: a board layout chosen for the cycle screen must not follow the
    // reader into the team's list, which is the annoyance per-view memory exists to prevent.
    let cookie = withIssueDisplay(undefined, 'cycle', display({ layout: 'board' }))
    cookie = withIssueDisplay(cookie, 'team:ENG:issues', display({ order: 'created' }))
    expect(issueDisplayFor(cookie, 'cycle').layout).toBe('board')
    expect(issueDisplayFor(cookie, 'team:ENG:issues').layout).toBe('list')
    // A view nobody has configured answers with the defaults rather than someone else's screen.
    expect(issueDisplayFor(cookie, 'workspace:issues')).toEqual(DEFAULT_ISSUE_DISPLAY)
  })

  it('falls back per field when the stored word is no longer in the vocabulary', () => {
    // The cookie outlives the code that wrote it. One renamed grouping must cost that grouping, not the whole
    // preference — the reader keeps the ordering and layout they chose.
    const stale = 'team%3AENG%3Aissues=byMoonPhase-priority-board-1-top'
    expect(issueDisplayFor(stale, 'team:ENG:issues')).toEqual({
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
      'cycle',
      display({ layout: 'board', grouping: 'none' })
    )
    expect(issueDisplayFor(cookie, 'cycle').grouping).toBe('status')
  })

  it('remembers a bounded number of views, dropping the least recently changed', () => {
    // A cookie rides every request, so this cannot grow forever. The evicted view reverts to the defaults, which
    // is a smaller loss than an unbounded header.
    let cookie = withIssueDisplay(undefined, 'team:FIRST:issues', display({ order: 'created' }))
    for (let i = 0; i < 12; i += 1) {
      cookie = withIssueDisplay(cookie, `team:T${i}:issues`, display({ order: 'due' }))
    }
    expect(issueDisplayFor(cookie, 'team:FIRST:issues')).toEqual(DEFAULT_ISSUE_DISPLAY)
    expect(issueDisplayFor(cookie, 'team:T11:issues').order).toBe('due')
  })

  it('names a view by its address, because that is what the reader thinks they are configuring', () => {
    expect(issueViewKeyOf({})).toBe('workspace:issues')
    expect(issueViewKeyOf({ team: 'ENG' })).toBe('team:ENG:issues')
    expect(issueViewKeyOf({ team: 'ENG', triage: true })).toBe('team:ENG:triage')
    // Every cycle board shares one key: a key per cycle would add an entry per fortnight, and how someone reads
    // a cycle board does not change when the cycle does.
    expect(issueViewKeyOf({ team: 'ENG', cycle: true })).toBe('cycle')
  })
})
