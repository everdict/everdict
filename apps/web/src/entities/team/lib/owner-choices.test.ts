import { describe, expect, it } from 'vitest'

import { ownerChoicesFor } from './owner-choices'

// The picker must offer exactly what the control plane's `teamForNew` gate would accept — a wider menu is a
// list of guaranteed 403s, and the preselected default must land where the server's implicit fallback lands.
const TEAMS = [
  { id: 'team_default', key: 'GEN', name: 'General', isDefault: true },
  { id: 'team_eng', key: 'ENG', name: 'Engineering', isDefault: false },
  { id: 'team_platform', key: 'PLT', name: 'Platform', isDefault: false },
]

describe('ownerChoicesFor', () => {
  it('offers a member only the teams they are on, defaulting to their first team', () => {
    const choices = ownerChoicesFor(
      { roles: ['member'], teams: ['team_eng', 'team_platform'] },
      TEAMS,
      'datasets:write'
    )

    expect(choices.teams.map((t) => t.key)).toEqual(['ENG', 'PLT'])
    expect(choices.defaultTeamId).toBe('team_eng')
  })

  it('offers an admin every team, defaulting to the workspace default when they are on none', () => {
    const choices = ownerChoicesFor({ roles: ['admin'], teams: [] }, TEAMS, 'judges:write')

    expect(choices.teams.map((t) => t.key)).toEqual(['GEN', 'ENG', 'PLT'])
    expect(choices.defaultTeamId).toBe('team_default')
  })

  it("an admin's own team still wins over the workspace default", () => {
    const choices = ownerChoicesFor(
      { roles: ['admin'], teams: ['team_platform'] },
      TEAMS,
      'harnesses:register'
    )

    expect(choices.defaultTeamId).toBe('team_platform')
  })

  it('offers nothing to a role that cannot write the resource at all', () => {
    const choices = ownerChoicesFor(
      { roles: ['viewer'], teams: ['team_eng'] },
      TEAMS,
      'scorecards:run'
    )

    expect(choices.teams).toEqual([])
    expect(choices.defaultTeamId).toBeUndefined()
  })
})
