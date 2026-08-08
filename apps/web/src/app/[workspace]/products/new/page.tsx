import { getTranslations } from 'next-intl/server'

import { ProductForm, type RepoOption } from '@/features/manage-product'
import { repoOptionsSchema } from '@/entities/product'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 프로덕트 등록 — 폼의 선택지는 서버가 좁혀 온다(피커 규칙): 시리즈의 데이터셋/하네스/저지는 워크스페이스가
// 실제로 등록한 것들이고, 없는 id 는 컨트롤 플레인이 400 으로 거절한다.
export default async function NewProductPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('productsPage')
  const { ctx } = await currentPrincipal()

  // id 목록만 필요하다 — 실패해도 폼은 뜬다(선택지가 비어 있을 뿐).
  const ids = async (fetchIds: Promise<unknown>): Promise<string[]> => {
    try {
      const rows = (await fetchIds) as Array<{ id?: unknown }>
      return Array.isArray(rows)
        ? [...new Set(rows.map((row) => row.id).filter((id): id is string => typeof id === 'string'))]
        : []
    } catch {
      return []
    }
  }
  const [datasetOptions, harnessOptions, judgeOptions, repoOptions] = await Promise.all([
    ids(controlPlane.listDatasets(ctx)),
    ids(controlPlane.listHarnesses(ctx)),
    ids(controlPlane.listJudges(ctx)),
    // GitHub App 설치 레포 — 있으면 서비스 행이 피커가 되고, 없으면 수동 입력+연결 안내로 내려간다.
    controlPlane
      .listProductRepoOptions(ctx)
      .then((raw) => repoOptionsSchema.parse(raw))
      .catch((): RepoOption[] => []),
  ])

  return (
    <div className="space-y-6">
      <PageHeader title={t('newTitle')} description={t('newDescription')} />
      <Card className="max-w-3xl p-5">
        <ProductForm
          workspace={workspace}
          datasetOptions={datasetOptions}
          harnessOptions={harnessOptions}
          judgeOptions={judgeOptions}
          repoOptions={repoOptions}
        />
      </Card>
    </div>
  )
}
