import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { computeAnalysis } from './analysis'
import type { AnalysisConfig } from './analysis'

// ── THE CLIENT HALF OF A DUPLICATED ENGINE ─────────────────────────────────────────────────────────
//
// This pivot exists TWICE: here and in `@everdict/domain` (behind `POST /scorecards/query`). The
// duplication is load-bearing — the studio pivots an already-loaded list, and a round trip per filter
// toggle would make it unusable — so it stays. What did not hold was the LOCKSTEP: each file carried a
// comment saying the other is kept in step with it, which is a claim about another component with nothing
// checking it, and a census then found only this copy is ever called. A divergence would have been
// invisible for as long as nobody used the route.
//
// `fixtures/analysis-parity.json` is the one question both engines answer, and the domain has its own test
// over the same file. Neither imports the other — the web may not import `@everdict/domain` at all — so the
// fixture is what they meet at. It is read rather than imported for the same reason.
// docs/architecture/web-runtime-gap-census-spec.md

const fixture = JSON.parse(
  readFileSync(new URL('../../../../../../fixtures/analysis-parity.json', import.meta.url), 'utf8')
) as {
  cards: Parameters<typeof computeAnalysis>[0]
  cases: {
    name: string
    config: AnalysisConfig
    expect: { kind: string; rows: { key: string; value: number | null }[]; total: number }
  }[]
}

describe('computeAnalysis — the shared parity fixture', () => {
  it('has cases to check — an empty fixture would pass this suite while proving nothing', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
  })

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const out = computeAnalysis(fixture.cards, testCase.config)
      expect(out.kind).toBe(testCase.expect.kind)
      if (out.kind !== 'grid') throw new Error(out.kind)
      expect(out.total).toBe(testCase.expect.total)
      // `null` in the fixture is JSON's only way to write "no measured value" — which is NOT zero, and the
      // difference is what the second case is about.
      expect(out.rows.map((r) => ({ key: r.key, value: r.value ?? null }))).toEqual(testCase.expect.rows)
    })
  }
})
