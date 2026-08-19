import { describe, expect, it } from 'vitest'

import type { TraceSummary } from '@/entities/trace'

import type { TrajectoryMeta } from '../api/browse-trajectories'
import { traceRowText, trajectoryRowText } from './row-text'

// A browse row is only a handle if it VARIES. Both ledgers hand us a constant (the producer: an agent id, a
// root-span name) and a variable (the work: the message, the case, the input) — these fix which one leads.

function meta(over: Partial<TrajectoryMeta>): TrajectoryMeta {
  return {
    runId: 'r-0f3a91',
    source: 'run',
    eventCount: 4,
    sealedAt: '2026-08-12T00:00:00.000Z',
    ...over,
  }
}

describe('trajectoryRowText — the owned ledger row', () => {
  it('leads with the message for an agent turn, because the label is the agent every sibling row shares', () => {
    // Given two turns of the same agent — the reported `default <uuid>` case
    const first = trajectoryRowText(
      meta({ kind: 'agent', label: 'default', preview: 'analyze the failing payment logs' })
    )
    const second = trajectoryRowText(
      meta({
        runId: 'r-7bd210',
        kind: 'agent',
        label: 'default',
        preview: 'draft the release notes',
      })
    )
    // Then the headlines differ and the agent survives as a chip
    expect(first.headline).toBe('analyze the failing payment logs')
    expect(second.headline).toBe('draft the release notes')
    expect(first.chip).toBe('default')
    expect(first.headlineIsId).toBe(false)
  })

  it('leads with the label for a work-named kind, and keeps the message underneath', () => {
    // Given an eval case, whose label already names the work
    const row = trajectoryRowText(
      meta({ kind: 'eval', label: 'billing-suite#case-07', preview: 'refund the duplicate charge' })
    )
    // Then the case leads and the task explains it — no chip, since nothing is left over
    expect(row).toMatchObject({
      headline: 'billing-suite#case-07',
      sub: 'refund the duplicate charge',
      headlineIsId: false,
    })
    expect(row.chip).toBeUndefined()
  })

  it('names an OTLP arrival by its preview — it has no label at all', () => {
    const row = trajectoryRowText(meta({ source: 'otlp', preview: 'checkout.submit' }))
    expect(row).toMatchObject({ headline: 'checkout.submit', sub: 'r-0f3a91', subIsId: true })
  })

  it('falls back to the id only when the row truly has nothing else, and says so', () => {
    // Given evidence sealed before the preview column existed and with no label either
    const row = trajectoryRowText(meta({}))
    // Then the id leads and is marked as an id, so the view can render it mono instead of as a title
    expect(row).toEqual({ headline: 'r-0f3a91', headlineIsId: true })
  })

  it('treats a blank stored value as absent rather than as a title', () => {
    const row = trajectoryRowText(meta({ kind: 'agent', label: '   ', preview: 'ship it' }))
    expect(row.headline).toBe('ship it')
    expect(row.chip).toBeUndefined()
  })
})

describe('traceRowText — the platform row', () => {
  it("leads with the trace's own input, not the root-span name every trace in the project shares", () => {
    const row = traceRowText({
      id: 'tr-8f2e',
      name: 'ChatCompletion',
      preview: '제주 3박 항공권 찾아줘',
    })
    expect(row.headline).toBe('제주 3박 항공권 찾아줘')
    expect(row.chip).toBe('ChatCompletion')
  })

  it('prefers the everdict case coordinate when the trace carries one and said nothing itself', () => {
    // Given a trace our own sink exported: the platform named it, and provenance says which case it IS
    const row = traceRowText({
      id: 'tr-91ab',
      name: 'ChatCompletion',
      provenance: { dataset: 'travel-v2', caseId: 'case-03', scorecardId: 'sc-8821' },
    })
    // Then the row reads as the case, which is how a member refers to it
    expect(row.headline).toBe('travel-v2#case-03')
    expect(row.chip).toBe('ChatCompletion')
  })

  it('keeps the case as the second line when the input already leads', () => {
    const row = traceRowText({
      id: 'tr-91ab',
      preview: 'book a hotel in busan',
      provenance: { dataset: 'travel-v2', caseId: 'case-03' },
    })
    expect(row).toMatchObject({ headline: 'book a hotel in busan', sub: 'travel-v2#case-03' })
  })

  it('falls back to the platform name, then to the id', () => {
    expect(traceRowText({ id: 'tr-1', name: 'ChatCompletion' })).toMatchObject({
      headline: 'ChatCompletion',
      headlineIsId: false,
    })
    const bare: TraceSummary = { id: 'tr-2' }
    expect(traceRowText(bare)).toEqual({ headline: 'tr-2', headlineIsId: true })
  })
})
