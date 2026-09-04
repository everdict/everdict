import { notFound, redirect } from 'next/navigation'
import { GitBranch } from 'lucide-react'
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server'

import { ProductTimelineView, ProductVersionLedger } from '@/widgets/product-timeline'
import {
  AutoEvalToggle,
  PlanReleaseButton,
  ProductActionsMenu,
  RunSeriesButton,
  SyncProductButton,
} from '@/features/manage-product'
import { memberDirectoryOf, membersSchema, type Member } from '@/entities/member'
import {
  productDetailSchema,
  productHref,
  productRef,
  productTimelineSchema,
  releaseHref,
  ReleaseStatusBadge,
  type ProductDetail,
  type ProductTimeline,
} from '@/entities/product'
import { TrackerHistory } from '@/entities/tracker-history'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { loadProductVersions } from '@/features/product-versions'

export const dynamic = 'force-dynamic'

// The timeline's visible PAST — the server default is one quarter (the width a release conversation looks at), and any other width is
// chosen by a person through the URL. Filters live in the URL (the web rule), so a pasted link opens the same window; the default (3m) lives with no parameter.
const TIMELINE_RANGES = [
  { key: '1m', days: 30 },
  { key: '3m', days: 90 },
  { key: '6m', days: 180 },
  { key: '1y', days: 365 },
] as const
type TimelineRangeKey = (typeof TIMELINE_RANGES)[number]['key']

// The product detail — the TIMELINE is the body: releases (past and planned) · the watch series' trend · the version ledger · linked issues.
// All of it drawn from two reads the server composed (the detail and the timeline). The web derives nothing.
export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ range?: string }>
}) {
  const { workspace, id } = await params
  const { range } = await searchParams
  const t = await getTranslations('productPage')
  const locale = await getLocale()
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()
  // Best-effort: a version read that fails must not take the product page down with it.
  const versions = await loadProductVersions(ctx, id)

  // An unknown range falls back to the default width — better than a mistyped parameter becoming a blank screen.
  const activeRange: TimelineRangeKey =
    TIMELINE_RANGES.find((preset) => preset.key === range)?.key ?? '3m'
  const rangeDays = TIMELINE_RANGES.find((preset) => preset.key === activeRange)?.days
  const window =
    activeRange === '3m' || rangeDays === undefined
      ? undefined // the server default (one quarter) — recomputing `from` here would define "the default" twice, in the server and in the web
      : { from: new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString() }

  let product: ProductDetail
  let timeline: ProductTimeline
  try {
    ;[product, timeline] = await Promise.all([
      controlPlane.getProduct(ctx, id).then((raw) => productDetailSchema.parse(raw)),
      controlPlane
        .getProductTimeline(ctx, id, window)
        .then((raw) => productTimelineSchema.parse(raw)),
    ])
  } catch {
    notFound()
  }
  // The address is collapsed to ONE — the control plane resolves both the slug and the id to the same record (so old links do not break),
  // but the address left on screen must be the slug. The same rule by which the issue detail normalizes to `ENG-12`, and this is the only
  // point where that normalization happens (a release detail's back link uses the productId).
  if (id !== productRef(product))
    redirect(
      `${productHref(workspace, productRef(product))}${activeRange !== '3m' ? `?range=${activeRange}` : ''}`
    )
  // The actor names for the history rows — the screen still renders on failure (a subject just stays as its raw string).
  let members: Member[] = []
  try {
    members = membersSchema.parse(await controlPlane.listMembers(ctx))
  } catch {
    members = []
  }
  const actors = memberDirectoryOf(members)

  const canWrite = can(principal?.roles ?? [], 'issues:write')

  return (
    <div className="@container space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {product.icon && <span aria-hidden>{product.icon}</span>}
            {product.name}
          </span>
        }
        description={product.description}
        actions={
          canWrite ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <AutoEvalToggle
                productId={product.id}
                enabled={product.autoEval.enabled}
                {...(product.autoEval.runtime !== undefined
                  ? { runtime: product.autoEval.runtime }
                  : {})}
              />
              <SyncProductButton productId={product.id} />
              {/* The quality axis' manual door — Sync pulls VERSIONS, this runs the SERIES now. With no series at all there is no reason to
                  press it, so it is hidden (the same rule as empty-section hiding). */}
              {product.series.length > 0 && <RunSeriesButton productId={product.id} />}
              <PlanReleaseButton
                productId={product.id}
                seriesOptions={product.series.map((s) => ({ key: s.key, label: s.label }))}
              />
              <ProductActionsMenu workspace={workspace} productRef={productRef(product)} />
            </div>
          ) : null
        }
      />

        {/* The imported service versions underneath the releases — the insert-once ledger the watch series
          uses as its x-axis. Without it the page shows releases and cannot answer "what shipped between
          these two", which is what a timeline is for. */}
      <section className="space-y-2.5">
        <SectionHeader title={t('versionsHeading')} />
        {versions === undefined ? (
          <p className="text-[12px] text-faint">{t('versionsUnread')}</p>
        ) : versions.versions.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t('versionsEmpty')}</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60">
            {versions.versions.slice(0, 20).map((v, i) => (
              <li key={`${v.service ?? ''}@${v.version}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5">
                {v.service !== undefined && (
                  <span className="shrink-0 text-[12px] text-muted-foreground">{v.service}</span>
                )}
                <span className="shrink-0 font-mono text-[12.5px] font-[510]">{v.version}</span>
                <span className="min-w-0 flex-1 truncate text-right text-[11px] text-faint">{v.at ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Tracked services — the real repos this product is composed of, each with its sync state. Empty, the whole section hides. */}
      {product.services.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('servicesHeading')} />
          <div className="grid gap-2 @md:grid-cols-2 @3xl:grid-cols-3">
            {product.services.map((service) => (
              // The card is trapped in a grid track (1fr) — one inner line that does not shrink pushes the track and takes the card off
              // screen. So every line is min-w-0 + truncate, and only the icon is shrink-0.
              <Card key={service.name} className="min-w-0 space-y-1 p-3">
                <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-[510]">
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate" title={service.name}>
                    {service.name}
                  </span>
                </p>
                <p
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={
                    service.path !== undefined
                      ? `${service.repository}/${service.path}`
                      : service.repository
                  }
                >
                  {service.repository}
                  {/* Where this service lives in the monorepo — what distinguishes it from its sibling services in the same repo. */}
                  {service.path !== undefined && (
                    <span className="text-muted-foreground/70">/{service.path}</span>
                  )}
                </p>
                {service.sync?.lastError ? (
                  <p
                    className="truncate text-xs text-destructive"
                    title={service.sync.lastError.message}
                  >
                    {t('syncFailed', { message: service.sync.lastError.message })}
                  </p>
                ) : service.sync?.syncedAt ? (
                  <p className="text-xs text-muted-foreground">
                    {t('lastSynced', {
                      at: new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone,
                      }).format(new Date(service.sync.syncedAt)),
                    })}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('neverSynced')}</p>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}

      <ProductTimelineView
        workspace={workspace}
        productId={product.id}
        timeline={timeline}
        canWrite={canWrite}
        detailed
        toolbar={
          // The range preset — which width of window is being viewed. It is a filter, so the URL carries it (the default 3m with no parameter).
          <span className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5">
            {TIMELINE_RANGES.map((preset) => (
              <Link
                key={preset.key}
                href={`${productHref(workspace, productRef(product))}${preset.key !== '3m' ? `?range=${preset.key}` : ''}`}
                className={
                  preset.key === activeRange
                    ? 'rounded bg-secondary px-2 py-0.5 text-[11px] font-[510] text-foreground'
                    : 'rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground'
                }
              >
                {t(`range.${preset.key}`)}
              </Link>
            ))}
          </span>
        }
      />

      {/* The release list — newest plan first. Readiness (the gate) is answered by a release's own page (it is a fan-out read, so not in the list). */}
      {product.releases.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('releasesHeading')} />
          <div className="space-y-2">
            {product.releases.map((release) => (
              <Link
                key={release.id}
                href={releaseHref(workspace, release.id)}
                className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-[510]">
                  {release.name}
                </span>
                {/* The composition this release ships — the answer to "what went out" on a product where several services ship together. */}
                {release.components !== undefined && release.components.length > 0 && (
                  <span className="hidden truncate font-mono text-[11px] text-muted-foreground @2xl:inline">
                    {release.components
                      .map((component) => `${component.service} ${component.version ?? '—'}`)
                      .join(' · ')}
                  </span>
                )}
                {release.targetDate && (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {release.targetDate}
                  </span>
                )}
                <ReleaseStatusBadge status={release.status} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* The version ledger — per service. Mixed into one table in time order it could not answer "how far along is THIS service".
          Newest first by the REMOTE (GitHub) clock, and a prerelease stays marked as one (facts only). */}
      {(product.versions.length > 0 || product.services.length > 0) && (
        <section className="space-y-2.5">
          <SectionHeader title={t('versionsHeading')} />
          <ProductVersionLedger services={product.services} versions={product.versions} />
        </section>
      )}

      {product.history.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('historyHeading')} />
          <TrackerHistory
            kind="project"
            subject={t('subject')}
            entries={product.history}
            actors={actors}
            workspace={workspace}
          />
        </section>
      )}
    </div>
  )
}
