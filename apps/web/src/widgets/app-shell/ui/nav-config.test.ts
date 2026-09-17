import { describe, expect, it } from 'vitest'

import { ALL_NAV_ITEMS, ALL_SIDEBAR_ROWS, isNavItemActive } from './nav-config'

// The sidebar has one way of saying where you are: a single active row. Two rows lit at once makes that statement FALSE —
// this file states that invariant over the whole nav configuration (so it is checked as items are added).
const activeRows = (pathname: string, workspace = 'acme') =>
  ALL_SIDEBAR_ROWS.filter((item) => isNavItemActive(item, pathname, workspace)).map(
    (item) => item.labelKey
  )

describe('sidebar active state — at most one row owns a path', () => {
  it('lights exactly the row you are on', () => {
    expect(activeRows('/acme')).toEqual(['overview'])
    expect(activeRows('/acme/projects')).toEqual(['projects'])
    expect(activeRows('/acme/projects/p1')).toEqual(['projects'])
    expect(activeRows('/acme/members')).toEqual(['members'])
  })

  it('does not light the overview on every page — it owns the workspace root alone', () => {
    expect(activeRows('/acme/store/mine')).toEqual(['store'])
  })

  // Evaluation resources are a WORKSPACE axis, and each has a sidebar row — a collection with no row erases from the screen the very
  // fact that the product HAS it.
  it('gives every evaluation collection a workspace row of its own', () => {
    for (const collection of ['harnesses', 'datasets', 'judges', 'scorecards']) {
      expect(activeRows(`/acme/${collection}`)).toEqual([collection])
    }
  })

  // Regression: the nav points at a COLLECTION (`/scorecards`) while one of them lives at the SINGULAR address
  // (`/scorecard/{id}`). A plain prefix test therefore lit no row at all on a detail page — the row went dark
  // exactly when the reader had drilled into it.
  it('keeps the collection’s row lit when you open ONE of them', () => {
    expect(activeRows('/acme/project/p1')).toEqual(['projects'])
    expect(activeRows('/acme/initiative/i1')).toEqual(['initiatives'])
    expect(activeRows('/acme/view/v1')).toEqual(['views'])
    expect(activeRows('/acme/skill/s1')).toEqual(['skills'])
    // …and still through the decorative title slug an issue link carries.
    expect(
      isNavItemActive({ href: '/issues' }, '/acme/issue/ENG-12/the-judge-drops-cost-scores', 'acme')
    ).toBe(true)
    // The evaluation collections have a workspace-wide row again, so one of them lights its collection too.
    expect(activeRows('/acme/scorecard/sc-1')).toEqual(['scorecards'])
    expect(activeRows('/acme/harness/h1')).toEqual(['harnesses'])
    expect(activeRows('/acme/dataset/d1')).toEqual(['datasets'])
    expect(activeRows('/acme/judge/j1')).toEqual(['judges'])
    // …and one issue lights the Issues row, now that the collection has one.
    expect(activeRows('/acme/issue/ENG-12')).toEqual(['issues'])
  })

  // The sidebar's stated job is to lead with the tracker — Initiative ⊃ Project ⊃ Issue — and for a while it
  // did that with the LAST of the three missing: issues were palette-only, so the record every change campaign
  // hangs off could be reached only by someone who remembered a keyboard shortcut. A containment chain with a
  // hole in it is what this asserts against, because the hole was invisible in every other test: each one
  // named the rows that existed.
  it('gives every level of the tracker a row — a chain with a hole in it is a level nobody finds', () => {
    for (const level of ['initiatives', 'projects', 'issues']) {
      expect(activeRows(`/acme/${level}`)).toEqual([level])
    }
  })

  // The agent authoring surface is still thin, so its sidebar row was dropped — which does not mean the address disappeared.
  // These two statements have to stand together (no row, still in the palette) so the next person does not revert only one of them.
  it('keeps the agent fleet out of the sidebar while leaving it reachable from the palette', () => {
    expect(activeRows('/acme/agents')).toEqual([])
    expect(ALL_NAV_ITEMS.map((item) => item.href)).toContain('/agents')
  })

  it('scopes the answer to the workspace in the URL', () => {
    expect(activeRows('/other/projects')).toEqual([])
  })
})
