import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DEFAULT_CASE_DISPLAY } from '@/entities/scorecard'
import type { ListFilters } from '@/shared/lib/list-view'
import type { ListViewScope } from '@/shared/lib/load-list-view'

import en from '../../../../messages/en.json'
import type { ScorecardCaseView } from '../model/case-view'
import { ScorecardCasesProvider } from './case-dialog-context'
import { ScorecardCaseList } from './case-list'

// The reason this screen was redrawn IS this test: on a batch of 300 cases the first paint must not be 300
// rows, and the question that first screen has to answer is "what failed". A server render shows both.

const CASES = 300
const isFailure = (index: number) => index % 10 === 0

const cases: ScorecardCaseView[] = Array.from({ length: CASES }, (_, index) => ({
  key: `case-${index}`,
  caseId: `case-${index}`,
  occurrence: index,
  attempts: 1,
  verdict: !isFailure(index),
  scores: [
    {
      graderId: 'tests',
      metric: 'pass',
      value: isFailure(index) ? 0 : 1,
      pass: !isFailure(index),
    },
  ],
  errorCount: isFailure(index) ? 1 : 0,
  ...(isFailure(index) ? { errorSummary: `FAILURE ${index}` } : {}),
  hasScreenshot: false,
  hasTrace: false,
  taskSummary: `PASSING TASK ${index}`,
  tags: ['smoke'],
}))

const scope = (filters: ListFilters = {}): ListViewScope => ({
  basePath: '/acme/scorecard/s1',
  viewKey: 'scorecard-cases',
  filters,
  search: '',
  display: DEFAULT_CASE_DISPLAY,
})

const render = (filters?: ListFilters): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <ScorecardCasesProvider
        workspace="acme"
        scorecardId="s1"
        cases={cases}
        initialCaseId={undefined}
        scope={scope(filters)}
      >
        <ScorecardCaseList />
      </ScorecardCasesProvider>
    </NextIntlClientProvider>
  )

const drawnCaseIds = (html: string) => [...new Set(html.match(/case-\d+/g) ?? [])]

describe('scorecard case explorer — hundreds of cases', () => {
  it('draws a screenful, not the whole batch', () => {
    const ids = drawnCaseIds(render())

    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThan(60)
    expect(ids.length).toBeLessThan(CASES)
  })

  it('opens on the failures — the question the first screen has to answer', () => {
    const out = render()

    expect(out).toContain('FAILURE 0')
    expect(out).toContain('FAILURE 10')
    // The 30 failures stand ahead of the passes, so not one passing case is on the first screen.
    expect(out).not.toContain('PASSING TASK')
  })

  it('carries a filter from the URL into the first paint, count and all', () => {
    const out = render({ verdict: ['fail'] })

    expect(out).toContain('30 items')
    expect(out).toContain('FAILURE 0')
    expect(out).not.toContain('PASSING TASK')
  })

  it('stands the list toolbar — search, filter and display — over the rows', () => {
    const out = render()

    expect(out).toContain('Filter')
    expect(out).toContain('Display')
    expect(out).toContain(`${CASES} items`)
  })
})
