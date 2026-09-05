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
    // The line itself — it has to stand even with no future band.
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

describe('TimelineLanes capability lanes', () => {
  it('stands one lane per capability kind present, with marks linking to the capability detail', () => {
    const html = render(
      timelineWith({
        capabilities: [
          {
            kind: 'harness',
            id: 'copilot',
            version: '2.0.0',
            registeredAt: '2026-08-06T00:00:00.000Z',
            seriesKeys: ['quality'],
          },
          {
            kind: 'dataset',
            id: 'support-cases',
            version: '1.1.0',
            registeredAt: '2026-08-08T00:00:00.000Z',
            seriesKeys: ['quality'],
          },
        ],
      })
    )
    expect(html).toContain(`>${en.productPage.laneCapability.harness}<`)
    expect(html).toContain(`>${en.productPage.laneCapability.dataset}<`)
    // With no judge events there is no judge lane — an empty lane is not information.
    expect(html).not.toContain(`>${en.productPage.laneCapability.judge}<`)
    expect(html).toContain('copilot@2.0.0')
    expect(html).toContain('href="/acme/harness/copilot"')
    expect(html).toContain('href="/acme/dataset/support-cases"')
  })
})

describe('TimelineLanes issue track packing', () => {
  const issue = (id: string, createdAt: string, resolvedAt?: string) => ({
    id,
    identifier: id.toUpperCase(),
    title: `issue ${id}`,
    status: resolvedAt !== undefined ? 'done' : 'todo',
    via: 'product' as const,
    createdAt,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  })

  it('spreads three overlapping lifespans onto three distinct tracks', () => {
    // The old odd/even-by-index assignment laid the first and third on the same track, exactly overlapping — only as many tracks as there is
    // real overlap should be created.
    const html = render(
      timelineWith({
        issues: [
          issue('eng-1', '2026-08-02T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
          issue('eng-2', '2026-08-03T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
          issue('eng-3', '2026-08-04T00:00:00.000Z', '2026-08-12T00:00:00.000Z'),
        ],
      })
    )
    expect(html).toContain('top:10px')
    expect(html).toContain('top:22px')
    expect(html).toContain('top:34px')
  })

  it('reuses the first track once a lifespan has ended (no overlap → no extra track)', () => {
    const html = render(
      timelineWith({
        issues: [
          issue('eng-1', '2026-08-01T12:00:00.000Z', '2026-08-04T00:00:00.000Z'),
          issue('eng-2', '2026-08-10T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
        ],
      })
    )
    expect(html).toContain('top:10px')
    expect(html).not.toContain('top:22px')
  })
})
