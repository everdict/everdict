import { Package } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import {
  newProductHref,
  productHref,
  productsSchema,
  type Product,
} from '@/entities/product'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { markdownPreview } from '@/shared/lib/markdown-preview'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Products — "무엇을 배포하는가"의 축(docs/architecture/product-timeline.md). 한 줄이 제품 하나:
// 어떤 서비스들로 구성되고, 몇 개의 추이를 지켜보는지. 추이 자체는 상세의 타임라인이 그린다.
export default async function ProductsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('productsPage')
  const { principal, ctx } = await currentPrincipal()

  let products: Product[] = []
  let error: string | undefined
  try {
    products = productsSchema.parse(await controlPlane.listProducts(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
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
    <div className="@container space-y-6">
      <PageHeader title={t('title')} description={t('description')} actions={newButton} />

      {error ? (
        <Callout tone="danger">{t('loadError', { error })}</Callout>
      ) : products.length === 0 ? (
        <EmptyState
          icon={<Package strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          action={newButton}
        />
      ) : (
        <div className="space-y-2">
          {products.map((product) => (
            <Link
              key={product.id}
              href={productHref(workspace, product.id)}
              className="group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1.5 truncate text-[13px] font-[510] text-foreground">
                  {product.icon && <span aria-hidden>{product.icon}</span>}
                  <span className="truncate">{product.name}</span>
                </p>
                {product.description && (
                  <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                    {markdownPreview(product.description)}
                  </p>
                )}
              </div>
              {product.services.length > 0 && (
                <Badge tone="outline">{t('serviceCount', { count: product.services.length })}</Badge>
              )}
              {product.series.length > 0 && (
                <Badge tone="outline">{t('seriesCount', { count: product.series.length })}</Badge>
              )}
              {!product.autoEval.enabled && <Badge tone="neutral">{t('autoEvalOff')}</Badge>}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
