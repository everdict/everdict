import Link from 'next/link'

import { ScheduleList } from '@/features/manage-schedules'
import { schedulesSchema } from '@/entities/schedule'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function SchedulesPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const canWrite = can(principal?.roles, 'schedules:write')
  let error: string | undefined
  let schedules = schedulesSchema.parse([])
  try {
    schedules = schedulesSchema.parse(await controlPlane.listSchedules(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="예약"
        description={`${schedules.length}건 · 데이터셋×하니스를 cron 으로 주기 실행(회귀 추적)`}
        actions={
          canWrite ? (
            <Link href={`/${workspace}/schedules/new`} className={buttonVariants({ size: 'sm' })}>
              예약 생성
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : schedules.length === 0 ? (
        <EmptyState
          title="예약이 없습니다."
          hint="member 이상이면 '예약 생성'으로 데이터셋×하니스를 cron 으로 주기 실행하세요. 결과는 스코어카드 추이/회귀에 그대로 반영됩니다."
        />
      ) : (
        <ScheduleList schedules={schedules} canWrite={canWrite} />
      )}
    </div>
  )
}
