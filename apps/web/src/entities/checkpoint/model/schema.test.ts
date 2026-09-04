import { describe, expect, it } from 'vitest'

import { checkpointDetailSchema, checkpointSchema } from './schema'

// Handoff checkpoints are evidence about how a task STOPPED, and until census slice 5 they could be
// written by an agent, verified by an agent, and read by nobody else.
// docs/architecture/web-runtime-gap-census-spec.md

const served = {
  id: 'cp-1',
  tenant: 'acme',
  envelopeId: 'env-1',
  goal: 'migrate the store',
  role: 'implementer',
  createdBy: 'agent:triage',
  createdAt: '2026-09-04T00:00:00.000Z',
}

describe('checkpointSchema', () => {
  it('keeps NOT ASKED apart from asked-and-answered', () => {
    // Absent verification means nobody requested one. Defaulting it to a status would tell a reader the
    // handoff was checked, which is the opposite of true and unrecoverable from the row.
    expect(checkpointSchema.parse(served).verification).toBeUndefined()
    expect(checkpointSchema.parse({ ...served, verification: { status: 'confirmed' } }).verification?.status).toBe(
      'confirmed'
    )
  })

  it('requires the fields the LIST renders, so a row can never be half-drawn', () => {
    expect(() => checkpointSchema.parse({ ...served, goal: undefined })).toThrow()
    expect(() => checkpointSchema.parse({ ...served, createdBy: undefined })).toThrow()
  })

  it('defaults the transfer arrays so a detail page never indexes undefined', () => {
    const d = checkpointDetailSchema.parse(served)
    expect(d.facts).toEqual([])
    expect(d.decisions).toEqual([])
  })
})
