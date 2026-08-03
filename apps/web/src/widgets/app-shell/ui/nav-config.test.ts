import { describe, expect, it } from 'vitest'

import { teamHref, teamSectionHref } from '@/entities/team'

import { ALL_SIDEBAR_ROWS, isNavItemActive } from './nav-config'

// 사이드바가 지금 어디인지 말하는 방법은 활성 행 하나다. 두 행이 동시에 켜지면 그 말은 거짓이 된다 —
// 이 파일은 그 불변식을 나브 설정 전체에 대해 진술한다(항목이 늘어나도 같이 검사된다).
const activeRows = (pathname: string, workspace = 'acme') =>
  ALL_SIDEBAR_ROWS.filter((item) => isNavItemActive(item, pathname, workspace)).map(
    (item) => item.labelKey
  )

describe('sidebar active state — at most one row owns a path', () => {
  it('lights exactly the row you are on', () => {
    expect(activeRows('/acme')).toEqual(['overview'])
    expect(activeRows('/acme/projects')).toEqual(['projects'])
    expect(activeRows('/acme/projects/p1')).toEqual(['projects'])
    expect(activeRows('/acme/teams')).toEqual(['teams'])
  })

  it('does not light the overview on every page — it owns the workspace root alone', () => {
    expect(activeRows('/acme/store/mine')).toEqual(['store'])
  })

  // 회귀: `/teams` 행이 접두사만 보고 팀 하위 페이지를 자기 것이라 주장해, 팀의 자기 행과 함께 두 개가 켜졌다.
  // 팀 스코프 경로의 주인은 사이드바의 팀 그룹이며, 워크스페이스 나브의 어떤 행도 그 경로를 갖지 않는다.
  it('hands every team-scoped path to the team group, claiming none of it', () => {
    expect(activeRows(teamHref('acme', 'ENG'))).toEqual([])
    for (const section of ['issues', 'triage', 'cycles', 'projects', 'scorecards'] as const) {
      expect(activeRows(teamSectionHref('acme', 'ENG', section))).toEqual([])
    }
    expect(activeRows('/acme/teams/ENG/issues/ENG-12')).toEqual([])
  })

  it('scopes the answer to the workspace in the URL', () => {
    expect(activeRows('/other/projects')).toEqual([])
  })
})
