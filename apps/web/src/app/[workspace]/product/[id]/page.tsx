import { notFound } from 'next/navigation'
import { GitBranch } from 'lucide-react'
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server'

import { TrackerHistory } from '@/entities/tracker-history'
import { memberDirectoryOf, membersSchema, type Member } from '@/entities/member'
import {
  productDetailSchema,
  productTimelineSchema,
  releaseHref,
  ReleaseStatusBadge,
  type ProductDetail,
  type ProductTimeline,
} from '@/entities/product'
import {
  AutoEvalToggle,
  PlanReleaseButton,
  ProductActionsMenu,
  SyncProductButton,
} from '@/features/manage-product'
import { ProductTimelineView } from '@/widgets/product-timeline'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

// 프로덕트 상세 — 타임라인이 본문이다: 릴리즈(과거+계획) · 워치 시리즈의 추이 · 버전 원장 · 링크된 이슈.
// 전부 서버가 합성한 두 번의 read(상세 + 타임라인)로 그려진다. 웹은 파생하지 않는다.
export default async function ProductPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('productPage')
  const locale = await getLocale()
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let product: ProductDetail
  let timeline: ProductTimeline
  try {
    ;[product, timeline] = await Promise.all([
      controlPlane.getProduct(ctx, id).then((raw) => productDetailSchema.parse(raw)),
      controlPlane.getProductTimeline(ctx, id).then((raw) => productTimelineSchema.parse(raw)),
    ])
  } catch {
    notFound()
  }
  // 히스토리 행의 배우 이름 — 실패해도 화면은 뜬다(주체가 subject 문자열로 남을 뿐).
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
            <div className="flex items-center gap-3">
              <AutoEvalToggle
                productId={product.id}
                enabled={product.autoEval.enabled}
                {...(product.autoEval.runtime !== undefined ? { runtime: product.autoEval.runtime } : {})}
              />
              <SyncProductButton productId={product.id} />
              <PlanReleaseButton
                productId={product.id}
                seriesOptions={product.series.map((s) => ({ key: s.key, label: s.label }))}
              />
              <ProductActionsMenu workspace={workspace} productId={product.id} />
            </div>
          ) : null
        }
      />

      {/* 추적 서비스 — 이 제품을 구성하는 실제 레포들과 각자의 싱크 상태. 비어 있으면 섹션째 숨긴다. */}
      {product.services.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('servicesHeading')} />
          <div className="grid gap-2 @md:grid-cols-2 @3xl:grid-cols-3">
            {product.services.map((service) => (
              <Card key={service.name} className="space-y-1 p-3">
                <p className="flex items-center gap-1.5 text-[13px] font-[510]">
                  <GitBranch className="size-3.5 text-muted-foreground" />
                  {service.name}
                  <Badge tone="outline">{t(`source.${service.source}`)}</Badge>
                  {service.tagPrefix && <Badge tone="neutral">{service.tagPrefix}*</Badge>}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">{service.repository}</p>
                {service.sync?.lastError ? (
                  <p className="truncate text-xs text-destructive" title={service.sync.lastError.message}>
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

      <ProductTimelineView workspace={workspace} timeline={timeline} />

      {/* 릴리즈 목록 — 최근 계획부터. 준비도(게이트)는 릴리즈 자신의 페이지가 답한다(팬아웃 read 라 목록엔 없다). */}
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
                <span className="min-w-0 flex-1 truncate text-[13px] font-[510]">{release.name}</span>
                {release.targetDate && (
                  <span className="font-mono text-[11px] text-muted-foreground">{release.targetDate}</span>
                )}
                <ReleaseStatusBadge status={release.status} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* 버전 원장 — 원격(GitHub) 시계 기준 최신부터. 프리릴리즈는 그렇게 표시된 채로 남는다(사실만). */}
      {product.versions.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('versionsHeading')} />
          <div className="overflow-x-auto rounded-lg border bg-card shadow-raise">
            <table className="w-full text-[12.5px]">
              <tbody>
                {product.versions.slice(0, 30).map((version) => (
                  <tr key={version.id} className="border-b border-border/60 last:border-b-0">
                    <td className="px-3 py-1.5 font-[510]">{version.service}</td>
                    <td className="px-3 py-1.5 font-mono">
                      {version.url ? (
                        <a
                          href={version.url}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-primary hover:underline"
                        >
                          {version.version}
                        </a>
                      ) : (
                        version.version
                      )}
                      {version.prerelease && (
                        <Badge tone="warning" className="ml-2">
                          {t('prerelease')}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[11px] text-muted-foreground">
                      {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(
                        new Date(version.publishedAt)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
