import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { IngestScorecardForm } from '@/features/ingest-scorecard'
import { datasetsSchema } from '@/entities/dataset'
import { judgesSchema } from '@/entities/judge'
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
  let judges: { id: string }[] = []
  if (allowed) {
    try {
      datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
      judges = judgesSchema.parse(await controlPlane.listJudges(ctx))
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
        title="트레이스 인제스트"
        description="외부에서 이미 수행한 트레이스를 올려 scorecard 로 만듭니다(하니스 미실행). judge·비교에 그대로 쓰입니다."
      />
      {allowed ? (
        <Card className="p-5">
          <IngestScorecardForm datasets={datasets} judges={judges} />
        </Card>
      ) : (
        <EmptyState
          title="인제스트 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(scorecards:run)."
        />
      )}
    </div>
  )
}
