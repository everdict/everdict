import { describe, expect, it } from 'vitest'

import { RUN_WIRE_FIELD_KIND, runSchema } from './schema'

// The run's half of the census (docs/architecture/web-runtime-gap-census-spec.md). The compile-time guard
// beside `RUN_WIRE_FIELD_KIND` proves the web DECLARES every product fact; this proves the declaration
// accepts what the wire actually sends. `.strip()` is zod's default, so a field the schema does not declare
// vanishes SILENTLY — which is exactly how seven of these went missing.

const served = {
  id: 'run-1',
  tenant: 'acme',
  status: 'succeeded',
  harness: { id: 'h', version: '1.0.0' },
  caseId: 'c1',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  // The seven the census found.
  lineage: { retryOf: 'run-0' },
  placement: { where: 'runtime', target: 'nomad-1', isolation: 'gvisor' },
  outputs: { artifacts: ['artifact://a'], files: ['/out.txt'], summary: 'done', exitCode: 0 },
  visibility: 'workspace',
  class: 'batch',
  executionId: 'evd-sc-1-c1',
  webhookUrl: 'https://example.test/hook',
}

describe('the web decodes what the control plane serves about a run', () => {
  it.each([
    ['lineage.retryOf', (r: Record<string, unknown>) => (r.lineage as { retryOf?: string }).retryOf, 'run-0'],
    ['placement.where', (r: Record<string, unknown>) => (r.placement as { where: string }).where, 'runtime'],
    ['outputs.exitCode', (r: Record<string, unknown>) => (r.outputs as { exitCode?: number }).exitCode, 0],
    ['visibility', (r: Record<string, unknown>) => r.visibility, 'workspace'],
    ['class', (r: Record<string, unknown>) => r.class, 'batch'],
    ['executionId', (r: Record<string, unknown>) => r.executionId, 'evd-sc-1-c1'],
    ['webhookUrl', (r: Record<string, unknown>) => r.webhookUrl, 'https://example.test/hook'],
  ])('keeps %s through the decode', (_label, read, expected) => {
    expect(read(runSchema.parse(served) as unknown as Record<string, unknown>)).toEqual(expected)
  })

  it('refuses a placement the wire cannot produce — a narrower shape is the point of spelling it out', () => {
    // `passthrough()` here would take anything and let the wire's own shape change under the page without
    // the build noticing. That is why `_flatGuard` refused the loose version.
    expect(() => runSchema.parse({ ...served, placement: { where: 'somewhere-else' } })).toThrow()
  })

  it('records WHERE a product fact lives when another schema owns it', () => {
    // `caseSpec` read as a gap in the first census and is not one: `runCaseSpecSchema` decodes it beside
    // this schema, because the wire's is the whole EvalCase. An omission with a named owner is a decision;
    // an omission with none is the drift the map exists for.
    expect(RUN_WIRE_FIELD_KIND.caseSpec).toBe('elsewhere')
    const internal = Object.entries(RUN_WIRE_FIELD_KIND)
      .filter(([, kind]) => kind === 'internal')
      .map(([field]) => field)
      .sort()
    expect(internal).toEqual(['ownerEpoch', 'ownerReplica'])
  })
})
