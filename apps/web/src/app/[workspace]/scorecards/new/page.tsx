import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { RunScorecardForm } from '@/features/run-scorecard'
import { datasetsSchema } from '@/entities/dataset'
import { harnessesSchema } from '@/entities/harness'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewScorecardPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'scorecards:run')

  let datasets: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[] = []
  let harnesses: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[] = []
  if (allowed) {
    try {
      datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
      harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
    } catch {
      // 목록 실패해도 폼은 동작(선택지만 빔)
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
        title="스코어카드 실행"
        description="벤치마크로 하니스를 평가하고 점수를 모아요."
      />
      {allowed ? (
        <Card className="p-5">
          <RunScorecardForm datasets={datasets} harnesses={harnesses} />
        </Card>
      ) : (
        <EmptyState
          title="실행 권한이 없어요."
          hint="워크스페이스 관리자에게 권한을 요청해보세요."
        />
      )}
    </div>
  )
}
