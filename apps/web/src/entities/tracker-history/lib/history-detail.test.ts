import { describe, expect, it } from 'vitest'

import { detailFlag, detailNumber, detailString, detailStrings } from './history-detail'

// The detail bag is whatever the control plane wrote for that event, so a history row must degrade to
// "no chip" rather than render `[object Object]` / `undefined` when a field is missing or mistyped.
describe('tracker history detail readers', () => {
  it('reads a present string and drops a mistyped or empty one', () => {
    expect(detailString({ to: 'in_progress' }, 'to')).toBe('in_progress')
    expect(detailString({ to: 3 }, 'to')).toBeUndefined()
    expect(detailString({ to: '' }, 'to')).toBeUndefined()
    expect(detailString(undefined, 'to')).toBeUndefined()
  })

  it('keeps only the string members of a list field', () => {
    expect(detailStrings({ changed: ['title', 7, '', 'labels'] }, 'changed')).toEqual([
      'title',
      'labels',
    ])
    expect(detailStrings({ changed: 'title' }, 'changed')).toEqual([])
  })

  it('reads a finite number only', () => {
    expect(detailNumber({ openIssues: 0 }, 'openIssues')).toBe(0)
    expect(detailNumber({ openIssues: Number.NaN }, 'openIssues')).toBeUndefined()
    expect(detailNumber({ openIssues: '3' }, 'openIssues')).toBeUndefined()
  })

  it('treats only a real true as the flag — a forced completion must not be inferred', () => {
    expect(detailFlag({ forced: true }, 'forced')).toBe(true)
    expect(detailFlag({ forced: 'true' }, 'forced')).toBe(false)
    expect(detailFlag({ forced: 1 }, 'forced')).toBe(false)
    expect(detailFlag({}, 'forced')).toBe(false)
  })
})
