import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { scorecardsSchema, type ScorecardRecord } from '@/entities/scorecard'
import type { ListViewScope } from '@/shared/lib/load-list-view'

import en from '../../../../messages/en.json'
import { ScorecardList } from './scorecard-list'

// The reason this list draws a window IS this test. Measured before it, at 1000 batches the screen cost
// 128,490 DOM elements and 8.69MB of HTML built from 1MB of data — ~128 elements per row, because every chip
// on the card carries an icon — and 2.2s of render before anything could appear. A workspace whose CI files
// evaluations reaches that in weeks, which is why the list must not scale with the collection.

const N = 400

const record = (i: number): unknown => ({
  id: `batch-${String(i).padStart(4, '0')}`,
  tenant: 'acme',
  dataset: { id: 'terminal-bench-core', version: '1.4.2' },
  harness: { id: 'claude-code-agent', version: '2.1.0' },
  status: i % 7 === 0 ? 'failed' : 'succeeded',
  summary: [{ metric: 'tests_pass', count: 120, mean: 0.72, passRate: 0.72 }],
  createdBy: 'oidc|dana',
  runtime: 'nomad-eu',
  steps: [],
  // Two calendar days, so the default day grouping really stands headers.
  createdAt: new Date(Date.UTC(2026, 7, i % 2 === 0 ? 1 : 2, 0, 0, i % 60)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 7, i % 2 === 0 ? 1 : 2, 0, 14, i % 60)).toISOString(),
})

const scorecards: ScorecardRecord[] = scorecardsSchema.parse(
  Array.from({ length: N }, (_, i) => record(i))
)

const scope: ListViewScope = {
  basePath: '/acme/scorecards',
  viewKey: 'scorecards',
  filters: {},
  search: '',
  display: { grouping: 'day', order: 'recent' },
}

const render = (over: Partial<ListViewScope> = {}): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <ScorecardList
        workspace="acme"
        scorecards={scorecards}
        authors={{ 'oidc|dana': { name: 'Dana' } }}
        teams={[]}
        scope={{ ...scope, ...over }}
        runnerLabels={{}}
        viewer={{ subject: 'oidc|dana', admin: true }}
      />
    </NextIntlClientProvider>
  )

const drawnIds = (html: string) => [...new Set(html.match(/batch-\d{4}/g) ?? [])]

describe('scorecard list — a collection that only grows', () => {
  it('draws a screenful of rows, not the whole workspace', () => {
    const ids = drawnIds(render())

    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThan(40)
    expect(ids.length).toBeLessThan(N)
  })

  it('keeps the DOM off the collection size — the markup barely moves between 40 and 400 batches', () => {
    const few = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
        <ScorecardList
          workspace="acme"
          scorecards={scorecards.slice(0, 40)}
          authors={{ 'oidc|dana': { name: 'Dana' } }}
          teams={[]}
          scope={scope}
          runnerLabels={{}}
          viewer={{ subject: 'oidc|dana', admin: true }}
        />
      </NextIntlClientProvider>
    )
    const elementsOf = (html: string) => (html.match(/<[a-zA-Z]/g) ?? []).length

    // Ten times the data, within a rounding error of the same markup.
    expect(elementsOf(render())).toBeLessThan(elementsOf(few) * 1.3)
  })

  it('still stands the toolbar, the stat tiles and the day headers over it', () => {
    const out = render()

    expect(out).toContain('Filter')
    expect(out).toContain('Display')
    expect(out).toContain(`${N} items`)
    // The default grouping is the day it ran, and a header carries the group's own count.
    expect(out).toMatch(/aria-expanded="true"/)
  })

  it('carries a filter from the URL into the first paint', () => {
    const out = render({ filters: { status: ['failed'] } })
    const failed = scorecards.filter((s) => s.status === 'failed').length

    expect(out).toContain(`${failed} items`)
    expect(failed).toBeLessThan(N)
  })
})
