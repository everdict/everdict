import { describe, expect, it } from 'vitest'

import { SCORECARD_WIRE_FIELD_KIND, scorecardRecordSchema } from './schema'

// ── THE FACTS THE CONTROL PLANE SERVES ACTUALLY SURVIVE THE DECODE ──────────────────────────────────
//
// The compile-time guard beside `SCORECARD_WIRE_FIELD_KIND` proves the web DECLARES every product field.
// It cannot prove the declaration accepts what the wire actually sends — a schema can name a field and
// then reject its real shape, which is strictly worse than omitting it: the field looks handled and the
// whole record fails to parse. So this drives a record carrying all nine through the real schema.
//
// The six that were MISSING when the census was taken are named individually below, because a test that
// only checks a blob would go on passing if one of them were quietly dropped again.
// docs/architecture/web-runtime-gap-census-spec.md

const served = {
  id: 'sc-1',
  tenant: 'acme',
  dataset: { id: 'd', version: '1.0.0' },
  harness: { id: 'h', version: '1.0.0' },
  status: 'succeeded',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  // …the nine the census found, in the shapes the control plane serves them.
  kind: 'scorecard',
  etaSeconds: 42,
  runIds: ['run-1', 'run-2'],
  verdictSummary: { passed: 3, verdicted: 4, policy: { id: 'default', version: '1.1.0' } },
  world: { os: 'linux', drivers: ['local'], runtimes: ['nomad'], images: ['img:1'], mixed: false, observed: 4, total: 4 },
  gates: [{ outcome: 'block', reason: 'missing_metrics', at: '2026-09-04T00:00:00.000Z' }],
  scoring: [{ revision: 1, kind: 'initial', scorePlaneDigest: 'sha256:abc', createdAt: '2026-09-04T00:00:00.000Z' }],
  executions: [
    { revision: 1, kind: 'retry', reason: 'flaky fixture', cases: [], createdAt: '2026-09-04T00:00:00.000Z', createdBy: 'alice' },
  ],
  decision: { by: 'alice', at: '2026-09-04T00:00:00.000Z' },
}

describe('the web decodes what the control plane serves', () => {
  it('parses a record carrying every product fact', () => {
    const parsed = scorecardRecordSchema.parse(served)
    expect(parsed.id).toBe('sc-1')
  })

  it.each([
    ['kind', (r: Record<string, unknown>) => r.kind, 'scorecard'],
    ['etaSeconds', (r: Record<string, unknown>) => r.etaSeconds, 42],
    ['gates length', (r: Record<string, unknown>) => (r.gates as unknown[]).length, 1],
    ['world.mixed', (r: Record<string, unknown>) => (r.world as { mixed: boolean }).mixed, false],
    ['scoring revision', (r: Record<string, unknown>) => (r.scoring as { revision: number }[])[0]?.revision, 1],
    ['executions reason', (r: Record<string, unknown>) => (r.executions as { reason?: string }[])[0]?.reason, 'flaky fixture'],
    ['runIds length', (r: Record<string, unknown>) => (r.runIds as string[]).length, 2],
  ])('keeps %s through the decode', (_label, read, expected) => {
    // `.strip()` is zod's default, so a field the schema does not declare is dropped SILENTLY — which is
    // exactly how these six went missing. Reading each one back is what makes the declaration load-bearing.
    expect(read(scorecardRecordSchema.parse(served) as unknown as Record<string, unknown>)).toEqual(expected)
  })

  it('classifies every wire field as product or internal, and internal means machinery', () => {
    // The map is exhaustive by construction (`satisfies Record<keyof ScorecardResponse, …>`); what a test
    // adds is the reason it is not all-product: these six are the control plane's own lifecycle, and a
    // reader of a scorecard is not reading any of them.
    const internal = Object.entries(SCORECARD_WIRE_FIELD_KIND)
      .filter(([, kind]) => kind === 'internal')
      .map(([field]) => field)
      .sort()
    expect(internal).toEqual([
      'executionPass',
      'ownerEpoch',
      'ownerReplica',
      'publication',
      'scoringPass',
      'traceProjectionVersion',
    ])
  })
})
