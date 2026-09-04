import { getTranslations } from 'next-intl/server'

import { ProductWizard, type RepoOption } from '@/features/manage-product'
import { repoOptionsSchema } from '@/entities/product'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Product registration — a stepped wizard. The choices are narrowed by the SERVER (the picker rule): a series' dataset/harness/judges are what
// the workspace actually registered, the repos are the GitHub App installation set (= exactly the set a sync can get a token for),
// and the service rows themselves are suggested by READING the repo. An id that does not exist is refused by the control plane with a 400.
export default async function NewProductPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const t = await getTranslations('productsPage')
  const { ctx } = await currentPrincipal()

  // Only the id lists are needed — the form renders even on failure (with empty choices).
  const ids = async (fetchIds: Promise<unknown>): Promise<string[]> => {
    try {
      const rows = (await fetchIds) as Array<{ id?: unknown }>
      return Array.isArray(rows)
        ? [
            ...new Set(
              rows.map((row) => row.id).filter((id): id is string => typeof id === 'string')
            ),
          ]
        : []
    } catch {
      return []
    }
  }
  const [datasetOptions, harnessOptions, judgeOptions, repoOptions] = await Promise.all([
    ids(controlPlane.listDatasets(ctx)),
    ids(controlPlane.listHarnesses(ctx)),
    ids(controlPlane.listJudges(ctx)),
    // The GitHub App's installed repos — present, the service rows become a picker; absent, it falls back to manual entry plus a connection prompt.
    controlPlane
      .listProductRepoOptions(ctx)
      .then((raw) => repoOptionsSchema.parse(raw))
      .catch((): RepoOption[] => []),
  ])

  return (
    <div className="space-y-6">
      <PageHeader title={t('newTitle')} description={t('newDescription')} />
      <Card className="max-w-3xl p-5">
        <ProductWizard
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
