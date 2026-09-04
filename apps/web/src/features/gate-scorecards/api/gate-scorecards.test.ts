import { describe, expect, it, vi } from 'vitest'

let reply: unknown = {}
vi.mock('@/shared/auth/principal', () => ({ authContext: async () => ({ devTenant: 'acme' }) }))
vi.mock('@/shared/lib/control-plane', () => ({ controlPlane: { gateScorecards: async () => reply } }))

const { gateScorecardsAction } = await import('./gate-scorecards')

// The release gate is CI's door and had never been a person's, so the decision a release rests on could not
// be rehearsed until a pipeline made it. docs/architecture/web-runtime-gap-census-spec.md
describe('gateScorecardsAction', () => {
  it.each(['pass', 'block', 'blocked_missing', 'not_comparable'] as const)('keeps %s as its own answer', async (o) => {
    // FOUR outcomes, and only `pass` is a green light. Collapsing `not_comparable` or `blocked_missing`
    // into "block" would tell a reader the candidate regressed when in fact nobody could tell.
    reply = { outcome: o }
    expect((await gateScorecardsAction('a', 'b')).outcome).toBe(o)
  })

  it('drops an outcome the control plane has no rule for rather than rendering it', async () => {
    // A badge for an unknown word is a UI inventing a verdict. Absent is the honest reading.
    reply = { outcome: 'probably-fine' }
    const out = await gateScorecardsAction('a', 'b')
    expect(out.ok).toBe(true)
    expect(out.outcome).toBeUndefined()
  })
})
