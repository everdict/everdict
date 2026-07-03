import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

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
        스코어카드
      </Link>
      <PageHeader
        title="트레이스 올리기"
        description="다른 곳에서 실행한 결과를 올려 스코어카드로 만들어요. 비교와 리더보드에 바로 쓸 수 있어요."
      />
      {allowed ? (
        <Card className="p-5">
          <IngestScorecardForm datasets={datasets} />
        </Card>
      ) : (
        <EmptyState
          title="올릴 권한이 없어요."
          hint="워크스페이스 관리자에게 권한을 요청해보세요."
        />
      )}
    </div>
  )
}
