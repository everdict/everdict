import { describe, expect, it } from 'vitest'

import { matchTeamPath, TEAM_SECTIONS, teamHref, teamSectionHref, teamSettingsHref } from './href'

// 팀 스코프는 쿼리 파라미터가 아니라 경로다 — 팀마다 가진 자원이 다르므로 주소가 그 사실을 말해야 하고,
// 그래야 붙여넣은 링크가 사람이 그 팀을 부르는 이름(`ENG`)으로 읽힌다.
describe('team hrefs — the team is a path segment, not a filter', () => {
  it('addresses a team by its key', () => {
    expect(teamHref('acme', 'ENG')).toBe('/acme/team/ENG')
  })

  it('puts what a team owns under the team', () => {
    expect(teamSectionHref('acme', 'ENG', 'issues')).toBe('/acme/team/ENG/issues')
    expect(teamSectionHref('acme', 'ENG', 'triage')).toBe('/acme/team/ENG/triage')
    expect(teamSectionHref('acme', 'ENG', 'cycles')).toBe('/acme/team/ENG/cycles')
  })

  // 평가 자원은 팀 아래에 살지 않는다 — 소유 팀은 남지만(누가 고칠 수 있나) 찾아가는 길은 워크스페이스
  // 목록 하나이고, "우리 팀 것만"은 그 목록의 필터 한 축이다. 팀 주소를 다시 만들면 사이드바의 「평가」
  // 그룹과 팀 탭이 같은 컬렉션을 두 곳에서 말하게 된다.
  it('keeps evaluation assets out of the team path — they are a workspace collection', () => {
    expect(TEAM_SECTIONS).not.toContain('harnesses')
    expect(TEAM_SECTIONS).not.toContain('datasets')
    expect(TEAM_SECTIONS).not.toContain('judges')
    expect(TEAM_SECTIONS).not.toContain('scorecards')
  })

  it('uses the same slug for the settings surface — one team, one name', () => {
    expect(teamSettingsHref('acme', 'ENG')).toBe('/acme/settings/teams/ENG')
  })

  // 설정은 탭 라우트다 — 'general' 은 세그먼트가 없는 자리라, 팀 설정의 짧은 주소가 곧 일반 설정이다.
  it('spells a team-settings tab as a segment under the team, and general as no segment at all', () => {
    expect(teamSettingsHref('acme', 'ENG', 'general')).toBe('/acme/settings/teams/ENG')
    expect(teamSettingsHref('acme', 'ENG', 'members')).toBe('/acme/settings/teams/ENG/members')
    expect(teamSettingsHref('acme', 'ENG', 'workflow')).toBe('/acme/settings/teams/ENG/workflow')
    expect(teamSettingsHref('acme', 'ENG', 'cycles')).toBe('/acme/settings/teams/ENG/cycles')
  })

  it('escapes a key so it can never break out of its segment', () => {
    expect(teamHref('acme', 'A/B')).toBe('/acme/team/A%2FB')
  })
})

// 주소를 다시 스코프로 읽는 쪽 — 사이드바가 "이 경로는 누구의 것인가"에 한 번만 답하게 하는 판정.
describe('matchTeamPath — one answer to who owns a path', () => {
  it('reads back what the href builders wrote', () => {
    // The team's short address IS its issue list — one screen, two spellings.
    expect(matchTeamPath(teamHref('acme', 'ENG'), 'acme')).toEqual({
      key: 'ENG',
      section: 'issues',
    })
    expect(matchTeamPath(teamSectionHref('acme', 'ENG', 'issues'), 'acme')).toEqual({
      key: 'ENG',
      section: 'issues',
    })
    expect(matchTeamPath(teamHref('acme', 'A/B'), 'acme')).toEqual({
      key: 'A/B',
      section: 'issues',
    })
  })

  it('leaves the team directory to the workspace nav — it is no team of its own', () => {
    expect(matchTeamPath('/acme/teams', 'acme')).toBeNull()
    expect(matchTeamPath('/acme/team/', 'acme')).toBeNull()
  })

  // An evaluation collection is no longer a team's — an address someone bookmarked while it was still is read
  // as "that team's screen, section unknown" rather than resurrecting a section that has no route.
  it('reads a retired evaluation address as the team’s, naming no section', () => {
    expect(matchTeamPath('/acme/team/ENG/harnesses', 'acme')).toEqual({ key: 'ENG', section: null })
    expect(matchTeamPath('/acme/team/ENG/judges', 'acme')).toEqual({ key: 'ENG', section: null })
  })

  it('keeps a detail page under the section that owns it', () => {
    expect(matchTeamPath('/acme/team/ENG/issues/ENG-12', 'acme')).toEqual({
      key: 'ENG',
      section: 'issues',
    })
  })

  // Regression: one of a team's cycles is spelled singular (`…/cycle/7`) while the section — and the nav row —
  // is the plural. Reading the singular back to its collection is what keeps the row lit on a cycle board.
  it('reads a singular detail segment back to the collection it belongs to', () => {
    expect(matchTeamPath('/acme/team/ENG/cycle/7', 'acme')).toEqual({
      key: 'ENG',
      section: 'cycles',
    })
    expect(matchTeamPath('/acme/team/ENG/cycles/all', 'acme')).toEqual({
      key: 'ENG',
      section: 'cycles',
    })
  })

  it('still names the team when the segment under it is not one we render', () => {
    expect(matchTeamPath('/acme/team/ENG/unknown', 'acme')).toEqual({ key: 'ENG', section: null })
  })

  it('answers only for the workspace it was asked about', () => {
    expect(matchTeamPath('/other/team/ENG/issues', 'acme')).toBeNull()
    expect(matchTeamPath('/acme/settings/teams/ENG', 'acme')).toBeNull()
    expect(matchTeamPath('/acme/projects', 'acme')).toBeNull()
  })

  it('treats the workspace slug as text, never as a pattern', () => {
    expect(matchTeamPath('/axc/team/ENG', 'a.c')).toBeNull()
  })

  it('survives a hand-typed key that cannot be decoded', () => {
    expect(matchTeamPath('/acme/team/%E0%A4%A/issues', 'acme')).toEqual({
      key: '%E0%A4%A',
      section: 'issues',
    })
  })
})
