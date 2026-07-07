import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { RunScorecardForm } from '@/features/run-scorecard'
import { datasetsSchema } from '@/entities/dataset'
import { harnessesSchema } from '@/entities/harness'
import { runnersResponseSchema } from '@/entities/runner'
import { runtimesSchema } from '@/entities/runtime'
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
  const t = await getTranslations('scorecardsPage')
  const allowed = can(principal?.roles, 'scorecards:run')

  let datasets: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[] = []
  let harnesses: { id: string; versions: string[]; versionTags?: Record<string, string[]> }[] = []
  let runtimes: { id: string }[] = []
  let runners: { id: string; label: string }[] = []
  let hasWorkspaceRunners = false
  if (allowed) {
    try {
      datasets = datasetsSchema.parse(await controlPlane.listDatasets(ctx))
      harnesses = harnessesSchema.parse(await controlPlane.listHarnesses(ctx))
    } catch {
      // 목록 실패해도 폼은 동작(선택지만 빔)
    }
    // 런타임 picker — 실행 위치는 필수(컨트롤플레인 호스트 폴백 금지 정책). 등록 런타임 + 러너 풀을 선택지로.
    try {
      runtimes = runtimesSchema.parse(await controlPlane.listRuntimes(ctx))
    } catch {
      // 런타임 목록 실패해도 폼은 동작(선택지만 빔)
    }
    // 내 로컬 러너 picker — 개인 소유 디바이스. 실패/없음이면 노출 안 함.
    try {
      runners = runnersResponseSchema.parse(await controlPlane.listRunners(ctx)).runners
    } catch {
      // 러너 목록 실패해도 폼은 동작
    }
    // 워크스페이스에 팀 공유 러너가 있으면 self:ws 풀 옵션 노출(members:read 로스터). 실패/없음이면 미노출.
    try {
      hasWorkspaceRunners =
        runnersResponseSchema.parse(await controlPlane.listWorkspaceRunners(ctx)).runners.length > 0
    } catch {
      // 로스터 실패해도 폼은 동작(풀 옵션만 숨김)
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
      <PageHeader title={t('run')} description={t('runDescription')} />
      {allowed ? (
        <Card className="p-5">
          <RunScorecardForm
            datasets={datasets}
            harnesses={harnesses}
            runtimes={runtimes}
            runners={runners}
            hasWorkspaceRunners={hasWorkspaceRunners}
          />
        </Card>
      ) : (
        <EmptyState title={t('noRunPermTitle')} hint={t('noPermHint')} />
      )}
    </div>
  )
}
