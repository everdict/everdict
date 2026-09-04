import { describe, expect, it } from 'vitest'

import { navGroupOpen } from './nav-group-open'

describe('nav group open state', () => {
  it('closes a group the user closed, even while it holds the current page', () => {
    // The one thing this file locks down — the toggle must not die just because the group holds the active item.
    expect(navGroupOpen({ recorded: false, holdsActive: true })).toBe(false)
  })

  it('opens the group that holds the current page when the user never said', () => {
    expect(navGroupOpen({ recorded: undefined, holdsActive: true })).toBe(true)
  })

  it('keeps a group the user opened open once the page moves elsewhere', () => {
    expect(navGroupOpen({ recorded: true, holdsActive: false })).toBe(true)
  })

  it('falls back to the group default when nothing else applies', () => {
    expect(navGroupOpen({ recorded: undefined, holdsActive: false })).toBe(false)
    expect(navGroupOpen({ recorded: undefined, holdsActive: false, whenUnrecorded: true })).toBe(
      true
    )
  })
})
