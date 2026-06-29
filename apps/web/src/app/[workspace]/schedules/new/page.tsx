import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { CreateScheduleForm } from '@/features/create-schedule'
import { datasetsSchema } from '@/entities/dataset'
import { harnessesSchema } from '@/entities/harness'
import { runtimesSchema } from '@/entities/runtime'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function NewSchedulePage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  const allowed = can(principal?.roles, 'schedules:write')

  let datasets: { id: string; versions: string[] }[] = []
  let harnesses: { id: string; versions: string[] }[] = []
  let runtimes: { id: string }[] = []
  if (allowed) {
    try {
      datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
      harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
      runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
    } catch {
      // 목록 실패해도 폼은 동작(텍스트/빈 선택)
    }
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/${workspace}/schedules`}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        예약
      </Link>
      <PageHeader title="예약 생성" description="데이터셋×하니스를 cron 으로 주기 실행합니다." />
      {allowed ? (
        <Card className="p-5">
          <CreateScheduleForm datasets={datasets} harnesses={harnesses} runtimes={runtimes} />
        </Card>
      ) : (
        <EmptyState
          title="예약 생성 권한이 없습니다."
          hint="member 이상 역할이 필요합니다(schedules:write). 워크스페이스 관리자에게 문의하세요."
        />
      )}
    </div>
  )
}
