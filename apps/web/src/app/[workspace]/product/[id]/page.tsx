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
  // 주소는 하나로 모은다 — 컨트롤 플레인은 슬러그와 id 를 둘 다 같은 레코드로 해석하지만(옛 링크가
  // 깨지지 않는다), 화면에 남는 주소는 슬러그여야 한다. 이슈 상세가 `ENG-12` 로 정규화하는 것과 같은
  // 규칙이고, 여기가 그 정규화가 일어나는 유일한 지점이다(릴리즈 상세의 뒤로가기는 productId 를 쓴다).
  if (id !== productRef(product)) redirect(productHref(workspace, productRef(product)))
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
            <div className="flex flex-wrap items-center justify-end gap-2">
              <AutoEvalToggle
                productId={product.id}
                enabled={product.autoEval.enabled}
                {...(product.autoEval.runtime !== undefined
                  ? { runtime: product.autoEval.runtime }
                  : {})}
              />
              <SyncProductButton productId={product.id} />
              {/* 품질 축의 수동 문 — Sync 는 버전을 당기고, 이건 시리즈를 지금 돌린다. 시리즈가 하나도
                  없으면 누를 이유가 없으므로 숨긴다(빈 섹션 숨김과 같은 규칙). */}
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

      {/* 추적 서비스 — 이 제품을 구성하는 실제 레포들과 각자의 싱크 상태. 비어 있으면 섹션째 숨긴다. */}
      {product.services.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('servicesHeading')} />
          <div className="grid gap-2 @md:grid-cols-2 @3xl:grid-cols-3">
            {product.services.map((service) => (
              // 카드는 그리드 트랙(1fr)에 갇힌다 — 안쪽 줄이 하나라도 안 줄어들면 트랙이 밀려 카드가
              // 화면 밖으로 나간다. 그래서 모든 줄이 min-w-0 + truncate 이고, 아이콘만 shrink-0 다.
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
                  {/* 모노레포에서 이 서비스가 사는 자리 — 같은 레포의 형제 서비스들과 구분되는 지점. */}
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
      />

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
                <span className="min-w-0 flex-1 truncate text-[13px] font-[510]">
                  {release.name}
                </span>
                {/* 이 릴리즈가 내보내는 구성 — 서비스 여럿이 함께 나가는 제품에서 "무엇이 나갔나"의 답. */}
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

      {/* 버전 원장 — 서비스별로. 한 표에 시간순으로 섞으면 "이 서비스는 지금 어디까지 왔나"에 답할 수
          없다. 원격(GitHub) 시계 기준 최신부터, 프리릴리즈는 그렇게 표시된 채로 남는다(사실만). */}
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
