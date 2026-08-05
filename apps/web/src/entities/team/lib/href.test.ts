import { describe, expect, it } from 'vitest'

import {
  matchTeamPath,
  TEAM_EVAL_SECTIONS,
  TEAM_SECTIONS,
  teamHref,
  teamSectionHref,
  teamSettingsHref,
} from './href'

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

  // 하네스·데이터셋·저지는 레지스트리에 `team_id` 를 들고 있으므로 이슈와 똑같이 팀이 소유한다 —
  // 워크스페이스 목록에 `?team=` 을 붙여 좁히던 시절에는 그 소유가 필터 뒤에 숨어 있었다.
  it('gives the team its evaluation assets an address of their own', () => {
    expect(teamSectionHref('acme', 'ENG', 'harnesses')).toBe('/acme/team/ENG/harnesses')
    expect(teamSectionHref('acme', 'ENG', 'datasets')).toBe('/acme/team/ENG/datasets')
    expect(teamSectionHref('acme', 'ENG', 'judges')).toBe('/acme/team/ENG/judges')
  })

  // 사이드바의 「평가」 아래 줄들은 전부 실제 팀 자원이어야 한다 — 아니면 라우트가 없는 링크가 된다.
  it('draws the evaluation group only from sections a team actually has', () => {
    for (const section of TEAM_EVAL_SECTIONS) {
      expect(TEAM_SECTIONS).toContain(section)
    }
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

  it('reads a team-owned evaluation asset back as belonging to that team', () => {
    expect(matchTeamPath(teamSectionHref('acme', 'ENG', 'harnesses'), 'acme')).toEqual({
      key: 'ENG',
      section: 'harnesses',
    })
    expect(matchTeamPath(teamSectionHref('acme', 'ENG', 'judges'), 'acme')).toEqual({
      key: 'ENG',
      section: 'judges',
    })
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
