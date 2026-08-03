import { describe, expect, it } from 'vitest'

import { ISSUE_LABEL_COLORS } from '../model/schema'
import { suggestLabelColor } from './color'

// 새 라벨이 전부 회색으로 태어나던 시절의 반대 방향을 잠근다: 이름이 있으면 팔레트의 색이 붙고, 같은 이름은
// 언제 물어도 같은 색이다(서버와 클라이언트가 다른 색을 그리면 하이드레이션이 깨진다).
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
    // 앞뒤 공백·대소문자는 같은 이름이다 — 서버가 트림한 뒤의 이름과 색이 갈리면 안 된다.
    expect(suggestLabelColor('  Flaky ')).toBe(suggestLabelColor('flaky'))
  })

  it('falls back to gray while there is no name to read', () => {
    expect(suggestLabelColor('   ')).toBe('gray')
  })
})
