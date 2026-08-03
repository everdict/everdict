import { describe, expect, it } from 'vitest'

import { matchTeamPath, teamHref, teamSectionHref, teamSettingsHref } from './href'

// 팀 스코프는 쿼리 파라미터가 아니라 경로다 — 팀마다 가진 자원이 다르므로 주소가 그 사실을 말해야 하고,
// 그래야 붙여넣은 링크가 사람이 그 팀을 부르는 이름(`ENG`)으로 읽힌다.
describe('team hrefs — the team is a path segment, not a filter', () => {
  it('addresses a team by its key', () => {
    expect(teamHref('acme', 'ENG')).toBe('/acme/teams/ENG')
  })

  it('puts what a team owns under the team', () => {
    expect(teamSectionHref('acme', 'ENG', 'issues')).toBe('/acme/teams/ENG/issues')
    expect(teamSectionHref('acme', 'ENG', 'triage')).toBe('/acme/teams/ENG/triage')
    expect(teamSectionHref('acme', 'ENG', 'cycles')).toBe('/acme/teams/ENG/cycles')
  })

  it('uses the same slug for the settings surface — one team, one name', () => {
    expect(teamSettingsHref('acme', 'ENG')).toBe('/acme/settings/teams/ENG')
  })

  it('escapes a key so it can never break out of its segment', () => {
    expect(teamHref('acme', 'A/B')).toBe('/acme/teams/A%2FB')
  })
})

// 주소를 다시 스코프로 읽는 쪽 — 사이드바가 "이 경로는 누구의 것인가"에 한 번만 답하게 하는 판정.
describe('matchTeamPath — one answer to who owns a path', () => {
  it('reads back what the href builders wrote', () => {
    expect(matchTeamPath(teamHref('acme', 'ENG'), 'acme')).toEqual({ key: 'ENG', section: 'home' })
    expect(matchTeamPath(teamSectionHref('acme', 'ENG', 'issues'), 'acme')).toEqual({
      key: 'ENG',
      section: 'issues',
    })
    expect(matchTeamPath(teamHref('acme', 'A/B'), 'acme')).toEqual({ key: 'A/B', section: 'home' })
  })

  it('leaves the team directory to the workspace nav — it is no team of its own', () => {
    expect(matchTeamPath('/acme/teams', 'acme')).toBeNull()
    expect(matchTeamPath('/acme/teams/', 'acme')).toBeNull()
  })

  it('keeps a detail page under the section that owns it', () => {
    expect(matchTeamPath('/acme/teams/ENG/issues/ENG-12', 'acme')).toEqual({
      key: 'ENG',
      section: 'issues',
    })
  })

  it('still names the team when the segment under it is not one we render', () => {
    expect(matchTeamPath('/acme/teams/ENG/unknown', 'acme')).toEqual({ key: 'ENG', section: null })
  })

  it('answers only for the workspace it was asked about', () => {
    expect(matchTeamPath('/other/teams/ENG/issues', 'acme')).toBeNull()
    expect(matchTeamPath('/acme/settings/teams/ENG', 'acme')).toBeNull()
    expect(matchTeamPath('/acme/projects', 'acme')).toBeNull()
  })

  it('treats the workspace slug as text, never as a pattern', () => {
    expect(matchTeamPath('/axc/teams/ENG', 'a.c')).toBeNull()
  })

  it('survives a hand-typed key that cannot be decoded', () => {
    expect(matchTeamPath('/acme/teams/%E0%A4%A/issues', 'acme')).toEqual({
      key: '%E0%A4%A',
      section: 'issues',
    })
  })
})
