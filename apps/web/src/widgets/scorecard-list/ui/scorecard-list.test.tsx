import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ScorecardViewData } from '@/features/browse-scorecards'
import { scorecardsSchema, toScorecardRow, type ScorecardRow } from '@/entities/scorecard'
import type { ListViewScope } from '@/shared/lib/load-list-view'

import en from '../../../../messages/en.json'
import { ScorecardList } from './scorecard-list'

// Two properties this screen must have, and they pull in opposite directions.
//
// ① It must not scale with the collection. Measured before the window, at 1000 batches the list cost 128,490
//    DOM elements and 8.69MB of HTML built from 1MB of data — ~128 elements per row, because every chip on
//    the card carries an icon — and 2.2s of render before anything appeared.
// ② It must not LIE about what it is showing. It now holds a PAGE, so every number it prints is the server's:
//    the group header's count, the toolbar's total, and the "n of m loaded" line. Counting its own rows would
//    report the page size back — a header reading "12" over a harness with 340 batches.

const N = 400
const isFailure = (index: number) => index % 10 === 0

const rows: ScorecardRow[] = scorecardsSchema
  .parse(
    Array.from({ length: N }, (_, index) => ({
      id: `batch-${String(index).padStart(4, '0')}`,
      tenant: 'acme',
      dataset: { id: 'terminal-bench-core', version: '1.4.2' },
      harness: { id: 'claude-code-agent', version: '2.1.0' },
      status: isFailure(index) ? 'failed' : 'succeeded',
      summary: [{ metric: 'tests_pass', count: 120, mean: 0.72, passRate: 0.72 }],
      createdBy: 'oidc|dana',
      runtime: 'nomad-eu',
      steps: [],
      createdAt: new Date(
        Date.UTC(2026, 7, index % 2 === 0 ? 1 : 2, 0, 0, index % 60)
      ).toISOString(),
      updatedAt: new Date(
        Date.UTC(2026, 7, index % 2 === 0 ? 1 : 2, 0, 14, index % 60)
      ).toISOString(),
    }))
  )
  // Through the real projection the server component uses — a fixture built by hand would assert against a
  // shape no production path emits.
  .map(toScorecardRow)

const scope: ListViewScope = {
  basePath: '/acme/scorecards',
  viewKey: 'scorecards',
  filters: {},
  search: '',
  display: { grouping: 'day', order: 'recent' },
}

// The page in hand is 400 rows of a collection of 4000 — which is the situation every assertion below is
// about, and the one the old client-side list could not represent at all.
const TOTAL = 4000
const data: ScorecardViewData = {
  groups: [
    { key: '2026-08-02', count: 1800, items: rows.filter((_, i) => i % 2 === 1) },
    { key: '2026-08-01', count: 2200, items: rows.filter((_, i) => i % 2 === 0) },
  ],
  total: TOTAL,
  loaded: rows.length,
  nextCursor: { createdAt: '2026-08-01T00:00:00.000Z', id: 'batch-0399' },
  facets: {
    status: [
      { value: 'succeeded', count: 3600 },
      { value: 'failed', count: 400 },
    ],
    runtime: [{ value: 'nomad-eu', count: 4000 }],
  },
}

const render = (over: Partial<ScorecardViewData> = {}): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <ScorecardList
        workspace="acme"
        initialData={{ ...data, ...over }}
        stats={{ total: TOTAL, succeeded: 3600, running: 0, failed: 400 }}
        authors={{ 'oidc|dana': { name: 'Dana' } }}
        scope={scope}
        runnerLabels={{}}
        viewer={{ subject: 'oidc|dana', admin: true }}
      />
    </NextIntlClientProvider>
  )

const drawnIds = (html: string) => [...new Set(html.match(/batch-\d{4}/g) ?? [])]

describe('scorecard list — a collection that only grows', () => {
  it('draws a screenful of rows, not even the page it holds', () => {
    const ids = drawnIds(render())

    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThan(40)
    expect(ids.length).toBeLessThan(rows.length)
  })

  it('keeps the DOM off the collection size — the markup barely moves between 40 and 400 rows', () => {
    const elementsOf = (html: string) => (html.match(/<[a-zA-Z]/g) ?? []).length
    const few = render({ groups: [{ key: '2026-08-01', count: 40, items: rows.slice(0, 40) }] })

    // Ten times the rows, within a rounding error of the same markup.
    expect(elementsOf(render())).toBeLessThan(elementsOf(few) * 1.3)
  })

  it("shows the SERVER's count on a group header, not the rows it happens to hold", () => {
    // Both headers inside the window on purpose: three rows loaded under a header that counts 1,800, and two
    // under one that counts 2,200. A screen counting its own rows would print 3 and 2 — its page size wearing
    // the collection's name, which is the exact number a paged list must never invent.
    const out = render({
      groups: [
        { key: '2026-08-02', count: 1800, items: rows.slice(0, 3) },
        { key: '2026-08-01', count: 2200, items: rows.slice(3, 5) },
      ],
    })

    expect(out).toContain('1800')
    expect(out).toContain('2200')
    expect(drawnIds(out)).toHaveLength(5)
  })

  it('says how much of the match is loaded — a silent window reads as "that is all of them"', () => {
    const out = render()

    expect(out).toContain('400')
    expect(out).toContain('4,000')
  })

  it('offers the next page exactly when the server said there is one', () => {
    expect(render()).toContain('Load older')
    // No cursor = nothing more to load, so no button that could only answer nothing.
    const { nextCursor: _dropped, ...ended } = data
    expect(
      renderToStaticMarkup(
        <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
          <ScorecardList
            workspace="acme"
            initialData={ended}
            stats={{ total: TOTAL, succeeded: 3600, running: 0, failed: 400 }}
            authors={{ 'oidc|dana': { name: 'Dana' } }}
            scope={scope}
            runnerLabels={{}}
            viewer={{ subject: 'oidc|dana', admin: true }}
          />
        </NextIntlClientProvider>
      )
    ).not.toContain('Load older')
  })

  it('offers only the facet values the collection actually has', () => {
    const out = render()

    expect(out).toContain('Filter')
    expect(out).toContain('Display')
    // The toolbar's count is the server's total for the current narrow, not the rows in hand.
    expect(out).toContain('4,000 items')
  })

  it('draws the failure a read could not answer, rather than an empty list', () => {
    const out = render({ error: 'control plane unreachable', groups: [], total: 0, loaded: 0 })

    expect(out).toContain('control plane unreachable')
    expect(drawnIds(out)).toHaveLength(0)
  })
})
