import Link from 'next/link'

import { datasetsSchema } from '@/entities/dataset'
import { harnessesSchema } from '@/entities/harness'
import { judgesSchema } from '@/entities/judge'
import { runtimesSchema } from '@/entities/runtime'
import { RunScorecardForm } from '@/features/run-scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewScorecardPage() {
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'scorecards:run')

  let datasets: { id: string }[] = []
  let harnesses: { id: string }[] = []
  let judges: { id: string }[] = []
  let runtimes: { id: string }[] = []
  if (allowed) {
    try {
      datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
      harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
      judges = judgesSchema.parse(await controlPlane.listJudges(ctx))
      runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
    } catch {
      // 목록 실패해도 폼은 텍스트 입력으로 동작
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/dashboard/scorecards" className="text-sm text-muted-foreground hover:text-foreground">
        ← 스코어카드
      </Link>
      <PageHeader title="스코어카드 실행" description="데이터셋을 하니스@버전으로 돌려 결과를 집계합니다." />
      {allowed ? (
        <Card className="p-6">
          <RunScorecardForm datasets={datasets} harnesses={harnesses} judges={judges} runtimes={runtimes} />
        </Card>
      ) : (
        <EmptyState
          title="스코어카드 실행 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(scorecards:run). 워크스페이스 관리자에게 문의하세요."
        />
      )}
    </div>
  )
}
