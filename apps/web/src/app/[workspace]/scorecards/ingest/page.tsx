import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { IngestScorecardForm } from '@/features/ingest-scorecard'
import { datasetsSchema } from '@/entities/dataset'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function IngestScorecardPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('scorecardsPage')
  const allowed = can(principal?.roles, 'scorecards:run')

  let datasets: { id: string }[] = []
  if (allowed) {
    try {
      datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
    } catch {
      // 목록 실패해도 폼은 텍스트 입력으로 동작
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/scorecards`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('backToList')}
      </Link>
      <PageHeader title={t('ingest')} description={t('ingestDescription')} />
      {allowed ? (
        <Card className="p-5">
          <IngestScorecardForm datasets={datasets} />
        </Card>
      ) : (
        <EmptyState title={t('noIngestPermTitle')} hint={t('noPermHint')} />
      )}
    </div>
  )
}
