import { describe, expect, it } from 'vitest'

import { teamHref, teamSectionHref, teamSettingsHref } from './href'

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
