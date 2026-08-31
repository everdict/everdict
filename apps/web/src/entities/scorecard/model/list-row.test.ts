import { describe, expect, it } from 'vitest'

import { toScorecardRow } from './list-row'
import { scorecardRecordSchema } from './schema'

// The list is a client island, so every field of every record handed to it is serialized into the page a
// second time. This projection is the whole reason the payload stopped scaling with things nobody draws —
// which is exactly the kind of rule that regresses silently, one convenient field at a time. So the test
// names the fields that must not come back, and pins the size.

const wire = {
  id: '01J8ZQ00000000000000000000',
  tenant: 'acme',
  dataset: { id: 'terminal-bench-core', version: '1.4.2' },
  harness: { id: 'claude-code-agent', version: '2.1.0' },
  status: 'succeeded',
  summary: [
    { metric: 'tests_pass', count: 120, mean: 0.72, passRate: 0.72, unmeasured: 2 },
    { metric: 'cost_usd', count: 120, mean: 1.83 },
    { metric: 'steps', count: 120, mean: 24.5 },
    { metric: 'judge:correctness', count: 120, mean: 0.81, passRate: 0.81 },
    { metric: 'judge:correctness:safety', count: 120, mean: 0.93 },
  ],
  models: {
    observed: ['claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5'],
    declared: 'claude-opus-5',
    primary: 'claude-opus-5',
  },
  judgeModels: ['claude-opus-5', 'claude-sonnet-5'],
  origin: {
    source: 'ci',
    repo: 'acme/product-platform',
    sha: 'd'.repeat(40),
    ref: 'refs/pull/1284/merge',
    prNumber: 1284,
    runUrl: 'https://github.com/acme/product-platform/actions/runs/12345678901',
    pinOverrides: { agent: `ghcr.io/acme/agent@sha256:${'a'.repeat(64)}` },
  },
  createdBy: 'oidc|00u1a2b3c4d5e6f7g8h9',
  teamId: 'team-01J8ZQAAAAAAAAAAAAAAAAAA',
  runtime: 'self:ws:01J8ZQRUNNER0000000000',
  // A subset run names every case it selected — the single heaviest thing on a row that draws "120/500".
  subset: {
    total: 500,
    selected: 120,
    ids: Array.from({ length: 120 }, (_, k) => `tb.core.task-${k}`),
    tags: ['smoke'],
    limit: 120,
  },
  headlinePassRate: 0.72,
  verdictPolicy: { id: 'default-ladder', version: '3.1.0', digest: `sha256:${'b'.repeat(64)}` },
  requested: 120,
  steps: [],
  createdAt: '2026-08-01T09:14:02.113Z',
  updatedAt: '2026-08-01T09:41:37.882Z',
}

const record = scorecardRecordSchema.parse(wire)
const row = toScorecardRow(record)
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

describe('scorecard list row — a row carries what a row draws', () => {
  it('keeps everything the card, the axes, the search and the delete gate read', () => {
    expect(row.id).toBe(record.id)
    expect(row.dataset).toEqual({ id: 'terminal-bench-core', version: '1.4.2' })
    expect(row.harness).toEqual({ id: 'claude-code-agent', version: '2.1.0' })
    expect(row.status).toBe('succeeded')
    expect(row.model).toBe('claude-opus-5')
    expect(row.createdBy).toBe(record.createdBy)
    expect(row.teamId).toBe(record.teamId)
    expect(row.runtime).toBe(record.runtime)
    expect(row.createdAt).toBe(record.createdAt)
    expect(row.updatedAt).toBe(record.updatedAt)
  })

  it('carries the three chips it stands, and every metric NAME behind them', () => {
    // The values stop at three (the card's format); the names do not, because a judge metric only reads
    // correctly beside its siblings and the "+N" is counted from them.
    expect(row.metrics.map((m) => m.metric)).toEqual(['tests_pass', 'cost_usd', 'steps'])
    expect(row.metricNames).toHaveLength(5)
    expect(row.metricNames).toContain('judge:correctness:safety')
  })

  it('carries one judge model and a count, not the roster', () => {
    expect(row.judgeModel).toBe('claude-opus-5')
    expect(row.judgeModelCount).toBe(2)
  })

  it('carries the subset COUNTS and not the case ids that make a subset row twice the size', () => {
    expect(row.subset).toEqual({ total: 500, selected: 120 })
    expect(JSON.stringify(row)).not.toContain('tb.core.task-0')
  })

  it('drops what no row draws', () => {
    const serialized = JSON.stringify(row)

    // OriginChip draws source · repo · short sha · PR number, and nothing else on this record.
    expect(row.origin).toEqual({
      source: 'ci',
      repo: 'acme/product-platform',
      sha: 'd'.repeat(40),
      prNumber: 1284,
    })
    for (const gone of [
      'refs/pull/1284/merge', // origin.ref
      'actions/runs', // origin.runUrl
      'ghcr.io', // origin.pinOverrides
      'claude-haiku', // models.observed
      'default-ladder', // verdictPolicy
      'acme"', // tenant
    ]) {
      expect(serialized).not.toContain(gone)
    }
  })

  it('is a fraction of the record it came from', () => {
    // Measured: ~4KB in, under 1KB out for a subset run. The bound is what stops it creeping back.
    expect(bytes(row)).toBeLessThan(bytes(record) / 2)
    expect(bytes(row)).toBeLessThan(1024)
  })
})
