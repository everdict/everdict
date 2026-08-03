import { describe, expect, it } from 'vitest'

import { navGroupOpen } from './nav-group-open'

describe('nav group open state', () => {
  it('closes a group the user closed, even while it holds the current page', () => {
    // 이 파일이 잠그는 것 하나 — 활성 항목을 품었다는 이유로 토글이 죽으면 안 된다.
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
