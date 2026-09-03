import { describe, expect, it } from 'vitest'

import { can } from './can'

// The UI mirror of the control plane's authz matrix. It never grants anything — it only decides whether a
// button is worth showing — so what matters is that it agrees with the server about the ONE axis the server
// has: the role. (There was a team axis; the workspace is now the only boundary, so a role that grants an
// action grants it over everything the workspace holds.)
describe('can — the role axis of the UI mirror', () => {
  it('refuses a write the role never granted', () => {
    expect(can(['viewer'], 'issues:write')).toBe(false)
  })

  it('grants a member the writes their role carries', () => {
    expect(can(['member'], 'issues:write')).toBe(true)
  })

  it('lets an admin through where a member is refused — admins govern the whole workspace', () => {
    expect(can(['member'], 'settings:write')).toBe(false)
    expect(can(['admin'], 'settings:write')).toBe(true)
  })

  it('refuses a caller with no roles at all rather than defaulting to a role', () => {
    expect(can(undefined, 'issues:read')).toBe(false)
    expect(can([], 'issues:read')).toBe(false)
  })
})
