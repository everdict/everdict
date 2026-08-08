import { Suspense } from 'react'
import { Package } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  newProductHref,
  productHref,
  productsSchema,
  productTimelineSchema,
  type Product,
} from '@/entities/product'
import { ProductTimelineView } from '@/widgets/product-timeline'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Skeleton } from '@/shared/ui/skeleton'

export const dynamic = 'force-dynamic'

// 홈 = 프로덕트 타임라인 (사용자 결정 2026-08-08: 펄스 현황판을 걷어내고 제품 축으로 교체).
//
// 워크스페이스가 결국 답해야 하는 질문은 "우리 제품이 릴리즈 사이에 어떻게 움직였나"다 — 릴리즈(과거+계획),
// 그 아래에서 움직인 서비스 버전, 워치 시리즈의 품질 추이, 걸린 이슈의 수명이 프로덕트마다 한 축에 눕는다.
// 프로덕트가 여럿이면 각자 자기 Suspense 로 스트리밍한다: 느린 타임라인 하나가 홈 전체를 잡지 않는다.
export default async function OverviewPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('overviewPage')
  const { principal, ctx } = await currentPrincipal()

  let products: Product[] = []
  try {
    products = productsSchema.parse(await controlPlane.listProducts(ctx))
  } catch {
    products = []
  }
  const canWrite = can(principal?.roles ?? [], 'issues:write')
  const newButton = canWrite ? (
    <Link
      href={newProductHref(workspace)}
      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-[510] text-primary-foreground transition-colors hover:bg-primary/90"
    >
      {t('newProduct')}
    </Link>
  ) : null

  return (
    <div className="@container space-y-7">
      <PageHeader title={t('title')} description={t('description')} actions={newButton} />

      {products.length === 0 ? (
        <EmptyState
          icon={<Package strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          action={newButton}
        />
      ) : (
        products.map((product) => (
          <Suspense
            key={product.id}
            fallback={
              <div className="space-y-3">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-40 w-full" />
              </div>
            }
          >
            <ProductTimelineSection workspace={workspace} product={product} ctx={ctx} />
          </Suspense>
        ))
      )}
    </div>
  )
}

// 프로덕트 하나의 타임라인 — 홈의 본문. 읽기 실패는 그 프로덕트 칸만 조용히 비운다(상세 페이지가 진짜
// 오류를 말한다); 컨트롤(싱크·릴리즈 계획·편집)은 전부 프로덕트 자기 페이지의 것이다.
async function ProductTimelineSection({
  workspace,
  product,
  ctx,
}: {
  workspace: string
  product: Product
  ctx: AuthContext
}) {
  const t = await getTranslations('overviewPage')
  let timeline
  try {
    timeline = productTimelineSchema.parse(await controlPlane.getProductTimeline(ctx, product.id))
  } catch {
    return null
  }
  return (
    <section className="space-y-3">
      <SectionHeader
        title={
          <Link
            href={productHref(workspace, product.id)}
            className="flex items-center gap-2 transition-colors hover:text-primary"
          >
            {product.icon && <span aria-hidden>{product.icon}</span>}
            {product.name}
          </Link>
        }
        action={
          <Link
            href={productHref(workspace, product.id)}
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('openProduct')}
          </Link>
        }
      />
      <ProductTimelineView workspace={workspace} timeline={timeline} />
    </section>
  )
}
