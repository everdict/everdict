import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'

import { productSchema, type Product } from '@/entities/product'
import { ProductForm, type RepoOption } from '@/features/manage-product'
import { repoOptionsSchema } from '@/entities/product'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 프로덕트 편집 — 등록 폼의 재사용(초기값 프리필). 리스트는 결과 집합으로 치환되고, 소스 좌표가 같은
// 서비스는 워터마크를 애그리게이트가 이어 준다.
export default async function EditProductPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('productsPage')
  const { ctx } = await currentPrincipal()

  let product: Product
  try {
    product = productSchema.parse(await controlPlane.getProduct(ctx, id))
  } catch {
    notFound()
  }

  const ids = async (fetchIds: Promise<unknown>): Promise<string[]> => {
    try {
      const rows = (await fetchIds) as Array<{ id?: unknown }>
      return Array.isArray(rows)
        ? [...new Set(rows.map((row) => row.id).filter((rid): rid is string => typeof rid === 'string'))]
        : []
    } catch {
      return []
    }
  }
  const [datasetOptions, harnessOptions, judgeOptions, repoOptions] = await Promise.all([
    ids(controlPlane.listDatasets(ctx)),
    ids(controlPlane.listHarnesses(ctx)),
    ids(controlPlane.listJudges(ctx)),
    controlPlane
      .listProductRepoOptions(ctx)
      .then((raw) => repoOptionsSchema.parse(raw))
      .catch((): RepoOption[] => []),
  ])

  return (
    <div className="space-y-6">
      <PageHeader title={t('editTitle', { name: product.name })} description={t('editDescription')} />
      <Card className="max-w-3xl p-5">
        <ProductForm
          workspace={workspace}
          datasetOptions={datasetOptions}
          harnessOptions={harnessOptions}
          judgeOptions={judgeOptions}
          repoOptions={repoOptions}
          initial={{
            id: product.id,
            name: product.name,
            ...(product.icon !== undefined ? { icon: product.icon } : {}),
            ...(product.description !== undefined ? { description: product.description } : {}),
            services: product.services.map((service) => ({
              name: service.name,
              repository: service.repository,
              ...(service.host !== undefined ? { host: service.host } : {}),
              source: service.source,
              ...(service.tagPrefix !== undefined ? { tagPrefix: service.tagPrefix } : {}),
            })),
            series: product.series,
          }}
        />
      </Card>
    </div>
  )
}
