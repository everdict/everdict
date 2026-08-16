import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { productTimelineSchema, type ProductTimeline } from '@/entities/product'

import en from '../../../../messages/en.json'
import { TimelineFeed } from './timeline-feed'

// The GitHub-style event feed — the same server-composed timeline read, told as day-grouped sentences.

const NOW = '2026-08-16T12:00:00.000Z'

const timeline = (overrides: Partial<ProductTimeline>): ProductTimeline =>
  productTimelineSchema.parse({
    window: { from: '2026-08-01T00:00:00.000Z', to: NOW, now: NOW },
    releases: [],
    versions: [],
    series: [],
    issues: [],
    capabilities: [],
    ...overrides,
  })

const render = (data: ProductTimeline): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={en}>
      <TimelineFeed workspace="acme" timeline={data} />
    </NextIntlClientProvider>
  )

describe('TimelineFeed', () => {
  it('renders nothing when the window holds no events (hide-empty)', () => {
    expect(render(timeline({}))).toBe('')
  })

  it('tells every axis in one day-grouped stream — version, issue lifecycle, evaluation, contract', () => {
    const html = render(
      timeline({
        versions: [
          {
            id: 'ver-1',
            tenant: 'default',
            productId: 'prod-1',
            service: 'api',
            version: 'v1.2.0',
            kind: 'release',
            prerelease: false,
            url: 'https://github.com/acme/api/releases/v1.2.0',
            publishedAt: '2026-08-10T09:00:00.000Z',
            importedAt: '2026-08-10T10:00:00.000Z',
          },
        ],
        series: [
          {
            key: 'quality',
            label: 'Quality',
            points: [
              {
                scorecardId: 'sc-1',
                status: 'succeeded',
                passRate: 0.8,
                createdAt: '2026-08-11T00:00:00.000Z',
                serviceVersion: 'api@v1.2.0',
              },
            ],
          },
        ],
        issues: [
          {
            id: 'issue-1',
            identifier: 'ENG-12',
            title: 'The judge drops cost scores',
            status: 'done',
            via: 'product',
            createdAt: '2026-08-05T08:00:00.000Z',
            resolvedAt: '2026-08-12T08:00:00.000Z',
            resolvedByScorecardId: 'sc-1',
          },
        ],
        capabilities: [
          {
            kind: 'judge',
            id: 'strict-judge',
            version: '1.1.0',
            registeredAt: '2026-08-09T00:00:00.000Z',
            seriesKeys: ['quality'],
          },
        ],
      })
    )
    // 한 이슈가 두 사건으로 선다 — 열림과 해결(해결은 딛고 선 증거 링크까지).
    expect(html).toContain(en.productPage.feed.issueOpened)
    expect(html).toContain(en.productPage.feed.issueResolved)
    expect(html).toContain('href="/acme/scorecard/sc-1"')
    // 버전 발행은 원격(GitHub)으로 나가는 문이다.
    expect(html).toContain(en.productPage.feed.versionPublished)
    expect(html).toContain('https://github.com/acme/api/releases/v1.2.0')
    // 시리즈 평가는 통과율과 함께, 계약(저지 버전 등록)은 능력 상세로 링크된 채.
    expect(html).toContain(en.productPage.feed.seriesEvaluated)
    expect(html).toContain(en.productPage.feed.capabilityRegistered)
    expect(html).toContain('href="/acme/judge/strict-judge"')
    expect(html).toContain('strict-judge@1.1.0')
    // 날짜 헤더 — 최신 날이 먼저 온다.
    expect(html.indexOf('Aug 12')).toBeLessThan(html.indexOf('Aug 5'))
  })
})
