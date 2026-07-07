import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RegisterDatasetForm } from '@/features/register-dataset'
import { datasetSchema, datasetsSchema, type Dataset } from '@/entities/dataset'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 데이터셋 새 버전 — 버전은 불변이라 "수정 = 새 버전". 현재 버전의 메타(설명/태그)와
// 케이스를 프리필하고, 값을 바꿔 다음 semver 로 배포한다(하니스 new-version 과 동일 패턴).
export default async function NewDatasetVersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ v?: string }>
}) {
  const { workspace, id } = await params
  const { v } = await searchParams
  const { principal, ctx } = await currentPrincipal()
  const t = await getTranslations('datasetsPage')
  const allowed = can(principal?.roles, 'datasets:write')

  let dataset: Dataset | undefined
  let error: string | undefined
  let existingDatasets: { id: string; versions: string[] }[] = []
  if (allowed) {
    try {
      dataset = datasetSchema.parse(await controlPlane.getDataset(ctx, id, v ?? 'latest'))
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    // 시스템 관리 버저닝: 기존 버전들에서 다음 semver(patch/minor/major)를 제안한다.
    try {
      existingDatasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
    } catch {
      existingDatasets = []
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/datasets/${encodeURIComponent(id)}`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {id}
      </Link>
      <PageHeader
        title={t('newVersion')}
        description={
          dataset
            ? t('newVersionDescWithVersion', { id, version: dataset.version })
            : t('newVersionDescNoVersion', { id })
        }
      />
      {!allowed ? (
        <EmptyState title={t('noPermTitle')} hint={t('noPermHint')} />
      ) : !dataset ? (
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      ) : (
        <Card className="p-5">
          <RegisterDatasetForm
            existingDatasets={existingDatasets}
            lockId
            prefill={{
              id: dataset.id,
              ...(dataset.description ? { description: dataset.description } : {}),
              tags: dataset.tags,
              casesText: JSON.stringify(dataset.cases, null, 2),
            }}
          />
        </Card>
      )}
    </div>
  )
}
