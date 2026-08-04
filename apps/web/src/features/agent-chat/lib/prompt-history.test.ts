import { beforeEach, describe, expect, it } from 'vitest'

import {
  EMPTY_PROMPT_HISTORY_CURSOR,
  isCaretOnFirstLine,
  isCaretOnLastLine,
  promptHistoryDown,
  promptHistoryUp,
  pushPromptHistory,
  readPromptHistory,
} from './prompt-history'

// The composer's ↑/↓ is the one place a member can lose work they never sent, so the rules here are behavioural,
// not cosmetic: the draft they were typing when they started browsing must come back, and the arrows must not
// steal a keypress the caret was going to use.

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  // A minimal localStorage — enough to exercise the dedupe/order rules without a DOM.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v)
        },
      },
    },
  })
})

describe('prompt history storage', () => {
  it('keeps the most recent prompt first and never repeats one', () => {
    pushPromptHistory('run the nightly suite')
    pushPromptHistory('compare the two scorecards')
    pushPromptHistory('run the nightly suite')
    // Re-sending an old prompt moves it to the front rather than sitting in the list twice — otherwise ↑↑ walks
    // over the same sentence.
    expect(readPromptHistory()).toEqual(['run the nightly suite', 'compare the two scorecards'])
  })

  it('ignores blank prompts and survives unreadable storage', () => {
    pushPromptHistory('   ')
    expect(readPromptHistory()).toEqual([])
    store.set('everdict:agent-chat:prompt-history', 'not json')
    expect(readPromptHistory()).toEqual([])
  })
})

describe('prompt history navigation', () => {
  const entries = ['newest', 'middle', 'oldest']

  it('walks back through the entries and returns to the draft it was started from', () => {
    // Given: a member typing something new who reaches for an older prompt.
    const first = promptHistoryUp(EMPTY_PROMPT_HISTORY_CURSOR, entries, 'half-typed thought')
    expect(first?.value).toBe('newest')
    // ↑ puts the caret at the START, so the next ↑ is not swallowed by the caret walking up the line.
    expect(first?.caret).toBe('start')

    const second = promptHistoryUp(first?.cursor ?? EMPTY_PROMPT_HISTORY_CURSOR, entries, 'newest')
    expect(second?.value).toBe('middle')

    // When: they come all the way back down.
    const back = promptHistoryDown(second?.cursor ?? EMPTY_PROMPT_HISTORY_CURSOR, entries)
    expect(back?.value).toBe('newest')
    const home = promptHistoryDown(back?.cursor ?? EMPTY_PROMPT_HISTORY_CURSOR, entries)

    // Then: the half-typed thought is exactly where they left it — browsing history never costs a draft.
    expect(home?.value).toBe('half-typed thought')
    expect(home?.cursor).toEqual(EMPTY_PROMPT_HISTORY_CURSOR)
  })

  it('stops at the oldest entry and at the draft instead of wrapping or blanking', () => {
    let cursor = EMPTY_PROMPT_HISTORY_CURSOR
    for (const expected of entries) {
      const step = promptHistoryUp(cursor, entries, '')
      expect(step?.value).toBe(expected)
      cursor = step?.cursor ?? cursor
    }
    // Past the oldest, nothing happens — the input keeps whatever it is showing.
    expect(promptHistoryUp(cursor, entries, '')).toBeNull()
    // And at the draft, ↓ declines too, so the key stays available to whatever else wants it.
    expect(promptHistoryDown(EMPTY_PROMPT_HISTORY_CURSOR, entries)).toBeNull()
  })

  it('offers nothing when there is no history at all', () => {
    expect(promptHistoryUp(EMPTY_PROMPT_HISTORY_CURSOR, [], 'draft')).toBeNull()
  })
})

describe('caret line detection', () => {
  it('lets the caret move within a multi-line draft before history takes the arrow', () => {
    const draft = 'first line\nsecond line'
    expect(isCaretOnFirstLine(draft, 3)).toBe(true)
    expect(isCaretOnFirstLine(draft, 14)).toBe(false)
    expect(isCaretOnLastLine(draft, 14)).toBe(true)
    expect(isCaretOnLastLine(draft, 3)).toBe(false)
  })

  it('treats a single-line draft as both first and last line', () => {
    expect(isCaretOnFirstLine('one line', 4)).toBe(true)
    expect(isCaretOnLastLine('one line', 4)).toBe(true)
  })
})
