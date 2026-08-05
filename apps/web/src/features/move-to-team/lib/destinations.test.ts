import { describe, expect, it } from 'vitest'

import { moveDestinationsFor } from './destinations'

// 화면이 제공하는 선택지는 제어 평면이 받아줄 것과 같아야 한다. 넓게 그려 놓고 403 을 받는 메뉴는
// "고를 수 있다"고 말해 놓고 못 고르게 하는 것이라, 이 규칙은 서버(canReachTeam)의 거울이다.
const TEAMS = [
  { id: 'team_eng', key: 'ENG', name: 'Engineering' },
  { id: 'team_platform', key: 'PLT', name: 'Platform' },
  { id: 'team_secret', key: 'SEC', name: 'Secret' },
]

describe('moveDestinationsFor', () => {
  it('offers a member exactly the teams they are on', () => {
    const options = moveDestinationsFor(
      { roles: ['member'], teams: ['team_eng', 'team_platform'] },
      TEAMS,
      'datasets:write'
    )

    // 이름 붙이기는 전부 — 읽기는 로스터의 일이 아니므로 남의 팀 소유도 그 팀의 키로 읽힌다.
    expect(options.teams.map((t) => t.key)).toEqual(['ENG', 'PLT', 'SEC'])
    expect(options.writableIds).toEqual(['team_eng', 'team_platform'])
  })

  it('lets an admin file into every team — an admin governs the whole workspace', () => {
    const options = moveDestinationsFor({ roles: ['admin'], teams: [] }, TEAMS, 'judges:write')

    expect(options.writableIds).toEqual(['team_eng', 'team_platform', 'team_secret'])
  })

  it('offers nothing to a role that cannot write the resource at all', () => {
    const options = moveDestinationsFor(
      { roles: ['viewer'], teams: ['team_eng'] },
      TEAMS,
      'scorecards:run'
    )

    expect(options.writableIds).toEqual([])
  })
})
