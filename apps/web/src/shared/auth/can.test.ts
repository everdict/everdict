import { describe, expect, it } from 'vitest'

import { can, canInTeam } from './can'

// The UI mirror of the control plane's authz matrix. It never grants anything — it only decides whether a
// button is worth showing — so what matters is that it agrees with the server on the two axes the server uses:
// the role, and the owning team.
describe('canInTeam — the team axis of the UI mirror', () => {
  const member = { roles: ['member'], teams: ['team-web'] }

  it('lets a member write in a team they are on', () => {
    expect(canInTeam(member, 'issues:write', 'team-web')).toBe(true)
  })

  it('refuses a write in a team they are not on — the control plane would 403 it', () => {
    expect(canInTeam(member, 'issues:write', 'team-mobile')).toBe(false)
  })

  it('refuses reads in a team they are not on — the control plane answers those 404, so the link is dead', () => {
    expect(canInTeam(member, 'issues:read', 'team-mobile')).toBe(false)
    expect(canInTeam(member, 'scorecards:read', 'team-mobile')).toBe(false)
    expect(canInTeam(member, 'issues:read', 'team-web')).toBe(true)
    expect(canInTeam(member, 'issues:read', undefined)).toBe(true) // unowned = the workspace's
  })

  it('lets an admin write across teams — a team they are not on must not be un-administrable', () => {
    expect(canInTeam({ roles: ['admin'], teams: [] }, 'issues:write', 'team-mobile')).toBe(true)
  })

  it('treats an unowned target as a workspace-level action rather than as everyone’s team', () => {
    expect(canInTeam(member, 'issues:write', undefined)).toBe(true)
  })

  it('still refuses what the ROLE never granted, whatever the team says', () => {
    const viewer = { roles: ['viewer'], teams: ['team-web'] }
    expect(can(viewer.roles, 'issues:write')).toBe(false)
    expect(canInTeam(viewer, 'issues:write', 'team-web')).toBe(false)
  })

  it('refuses when the principal carries no teams at all (a deployment without the roster)', () => {
    expect(canInTeam({ roles: ['member'] }, 'issues:write', 'team-web')).toBe(false)
  })
})
