import { describe, expect, it } from 'vitest'

import { ISSUE_LABEL_COLORS } from '../model/schema'
import { suggestLabelColor } from './color'

// It locks down the opposite direction from the days when every new label was born grey: a name gets a palette colour, and the same name gets the
// same colour whenever it is asked (the server and the client drawing different colours breaks hydration).
describe('suggested label color', () => {
  it('gives a name a color from the closed palette', () => {
    expect(ISSUE_LABEL_COLORS).toContain(suggestLabelColor('regression'))
  })

  it('never suggests gray for a named label — gray is a choice, not a suggestion', () => {
    const names = ['bug', 'regression', 'flaky', 'browser', 'p0', '한글 라벨', 'a']

    expect(names.map(suggestLabelColor)).not.toContain('gray')
  })

  it('answers the same for the same name, whoever asks', () => {
    expect(suggestLabelColor('flaky')).toBe(suggestLabelColor('flaky'))
    // Leading/trailing whitespace and case are the SAME name — the colour must not diverge from the name after the server trims it.
    expect(suggestLabelColor('  Flaky ')).toBe(suggestLabelColor('flaky'))
  })

  it('falls back to gray while there is no name to read', () => {
    expect(suggestLabelColor('   ')).toBe('gray')
  })
})
