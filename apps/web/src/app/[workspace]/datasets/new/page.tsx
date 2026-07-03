import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

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
  const allowed = can(principal?.roles, 'datasets:write')

  // 시스템 관리 버저닝: 기존 데이터셋 id→versions 를 폼에 넘겨 다음 semver 를 제안한다.
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
        데이터셋
      </Link>
      <PageHeader
        title="데이터셋 등록"
        description="평가 케이스를 워크스페이스에 등록해요."
      />
      {allowed ? (
        <Card className="p-5">
          <RegisterDatasetForm existingDatasets={existingDatasets} />
        </Card>
      ) : (
        <EmptyState
          title="등록 권한이 없어요."
          hint="워크스페이스 관리자에게 권한을 요청해보세요."
        />
      )}
    </div>
  )
}
