import { Suspense } from 'react'
import { Package } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { ProductTimelineView } from '@/widgets/product-timeline'
import {
  newProductHref,
  productHref,
  productRef,
  productsSchema,
  productTimelineSchema,
  type Product,
} from '@/entities/product'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane, type AuthContext } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Skeleton } from '@/shared/ui/skeleton'

export const dynamic = 'force-dynamic'

// Home = the product timeline (a user decision, 2026-08-08: the pulse status board was removed and replaced by the product axis).
//
// The question a workspace ultimately has to answer is "how did our product move between releases" — releases (past and planned), the service
// versions that moved beneath them, the watch series' quality trend, and the lifetime of the issues attached, laid on one axis per product.
// With several products, each streams behind its own Suspense: one slow timeline does not hold up the whole home screen.
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

// One product's timeline — the body of home. A read failure quietly empties only that product's slot (the detail page states the real error);
// the controls (sync, planning a release, editing) all belong to the product's own page.
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
            href={productHref(workspace, productRef(product))}
            className="flex items-center gap-2 transition-colors hover:text-primary"
          >
            {product.icon && <span aria-hidden>{product.icon}</span>}
            {product.name}
          </Link>
        }
        action={
          <Link
            href={productHref(workspace, productRef(product))}
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('openProduct')}
          </Link>
        }
      />
      {/* Home is a summary, so no actions are attached — running a series happens on the product's own screen. */}
      <ProductTimelineView
        workspace={workspace}
        productId={product.id}
        timeline={timeline}
        canWrite={false}
      />
    </section>
  )
}
