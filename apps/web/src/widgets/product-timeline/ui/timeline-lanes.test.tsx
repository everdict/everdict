import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { productTimelineSchema, type ProductTimeline } from '@/entities/product'

import en from '../../../../messages/en.json'
import { TimelineLanes } from './timeline-lanes'

// The today line answers "where is now on this axis" — that question exists whether or not the
// window stretches into the future. It used to render only when a planned release pushed the
// window past now, so a product with nothing scheduled showed no today marker at all.

const NOW = '2026-08-16T12:00:00.000Z'

const timelineWith = (overrides: Partial<ProductTimeline>): ProductTimeline =>
  productTimelineSchema.parse({
    window: { from: '2026-08-01T00:00:00.000Z', to: NOW, now: NOW },
    releases: [
      {
        id: 'rel-1',
        tenant: 'default',
        productId: 'prod-1',
        name: 'v1.2.0',
        status: 'released',
        releasedAt: '2026-08-10T09:00:00.000Z',
        history: [],
        createdBy: 'member-1',
        createdAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-10T09:00:00.000Z',
      },
    ],
    versions: [],
    series: [],
    issues: [
      {
        id: 'issue-1',
        identifier: 'ENG-12',
        title: 'The judge drops cost scores',
        status: 'done',
        via: 'product',
        createdAt: '2026-08-05T08:00:00.000Z',
        resolvedAt: '2026-08-12T08:00:00.000Z',
      },
    ],
    ...overrides,
  })

const render = (timeline: ProductTimeline): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <TimelineLanes workspace="acme" timeline={timeline} />
    </NextIntlClientProvider>
  )

describe('TimelineLanes today marker', () => {
  it('stands the today line even when the window ends today (nothing planned)', () => {
    const html = render(timelineWith({}))
    expect(html).toContain(`>${en.productPage.today}<`)
    // 선 자체 — 미래 밴드 없이도 서 있어야 한다.
    expect(html).toContain('bg-primary/40')
    expect(html).not.toContain('bg-muted/50')
  })

  it('adds the planned band only when the window stretches past now', () => {
    const html = render(
      timelineWith({
        window: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z', now: NOW },
      })
    )
    expect(html).toContain(`>${en.productPage.today}<`)
    expect(html).toContain('bg-muted/50')
  })

  it('keeps release and issue lifecycle marks on the axis', () => {
    const html = render(timelineWith({}))
    expect(html).toContain('v1.2.0')
    expect(html).toContain('ENG-12')
  })
})
