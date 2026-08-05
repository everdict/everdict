import { describe, expect, it } from 'vitest'

import { withResolvedTeamFilter } from './team-filter'

const teams = [
  { id: 'team-1', key: 'ENG' },
  { id: 'team-2', key: 'DES' },
]

// 평가 자원 목록이 팀 아래의 경로 자원이던 시절의 `?team=` 링크가 그대로 돌아다닌다. 같은 이름의 쿼리
// 파라미터가 이제 그 목록의 필터라서 리다이렉트가 필요 없지만, 값이 키로 적혀 있으면 아무것도 매치되지
// 않는다 — 그 링크는 "우리 팀 것만"이 아니라 "아무것도 없음"으로 열린다.
describe('the team filter — a legacy team-scoped link keeps working as a filter', () => {
  it('resolves a team KEY to the id the registry records', () => {
    expect(withResolvedTeamFilter({ team: ['ENG'] }, teams)).toEqual({ team: ['team-1'] })
    expect(withResolvedTeamFilter({ team: ['eng'] }, teams)).toEqual({ team: ['team-1'] })
  })

  it('leaves an id alone', () => {
    expect(withResolvedTeamFilter({ team: ['team-2'] }, teams)).toEqual({ team: ['team-2'] })
  })

  // 사라진 팀을 가리키는 필터를 조용히 넓히면 "우리 팀 것만"이 갑자기 전부가 된다.
  it('keeps an unknown value rather than widening the list', () => {
    expect(withResolvedTeamFilter({ team: ['gone'] }, teams)).toEqual({ team: ['gone'] })
  })

  it('touches nothing when no team is filtered', () => {
    expect(withResolvedTeamFilter({ category: ['cli-agent'] }, teams)).toEqual({
      category: ['cli-agent'],
    })
  })
})
