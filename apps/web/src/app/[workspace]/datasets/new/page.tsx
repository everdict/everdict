import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RegisterDatasetForm } from '@/features/register-dataset'
import { datasetsSchema } from '@/entities/dataset'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewDatasetPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('datasetsPage')
  const allowed = can(principal?.roles, 'datasets:write')

  // System-managed versioning: pass existing dataset id→versions to the form to suggest the next semver.
  let existingDatasets: { id: string; versions: string[] }[] = []
  if (allowed) {
    try {
      existingDatasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
    } catch {
      existingDatasets = []
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/datasets`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('backToList')}
      </Link>
      <PageHeader title={t('registerTitle')} description={t('registerDescription')} />
      {allowed ? (
        <Card className="p-5">
          <RegisterDatasetForm existingDatasets={existingDatasets} />
        </Card>
      ) : (
        <EmptyState title={t('noPermTitle')} hint={t('noPermHint')} />
      )}
    </div>
  )
}
