import { describe, expect, it } from 'vitest'

import { approvalListSchema, approvalSchema } from './schema'

// The approvals queue is the human's half of a human-in-the-loop decision, and it was unreachable from the
// web until census slice 3 — the control plane parked agent mutations that only the agent surface could
// answer. These pin what the page stands on.
// docs/architecture/web-runtime-gap-census-spec.md

const served = {
  id: 'ap-1',
  tenant: 'acme',
  sessionId: 's-1',
  agentId: 'triage',
  requestId: 'req-9',
  request: { name: 'write_file', input: { path: '/etc/x' } },
  status: 'pending',
  expiresAt: '2026-09-11T00:00:00.000Z',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
}

describe('approvalSchema', () => {
  it('keeps what a member decides on', () => {
    const a = approvalSchema.parse(served)
    expect(a.request.name).toBe('write_file')
    expect(a.status).toBe('pending')
    // Not deciding IS a decision — an approval that expires is denied — so the deadline has to survive the
    // decode or the row cannot say what silence costs.
    expect(a.expiresAt).toBe('2026-09-11T00:00:00.000Z')
  })

  it('drops requestId — the in-process registry key is plumbing, never identity', () => {
    // The control plane's own comment says it is "live-delivery correlation, never shown as identity". A
    // page that rendered it would be showing the machine.
    expect(approvalSchema.parse(served)).not.toHaveProperty('requestId')
  })

  it('accepts every terminal status the queue keeps, so a decided row still renders', () => {
    for (const status of ['approved', 'denied', 'expired'] as const)
      expect(approvalSchema.parse({ ...served, status }).status).toBe(status)
  })

  it('REFUSES a status the wire cannot produce', () => {
    // A passthrough string here would let a page render a state the control plane has no rule for.
    expect(() => approvalSchema.parse({ ...served, status: 'maybe' })).toThrow()
  })

  it('parses a queue, including an ad-hoc session with no registered agent', () => {
    const list = approvalListSchema.parse([served, { ...served, id: 'ap-2', agentId: undefined }])
    expect(list).toHaveLength(2)
    expect(list[1]?.agentId).toBeUndefined()
  })
})
