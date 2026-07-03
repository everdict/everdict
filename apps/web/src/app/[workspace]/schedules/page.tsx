import Link from 'next/link'

import { ScheduleList } from '@/features/manage-schedules'
import { membersSchema } from '@/entities/member'
import { schedulesSchema } from '@/entities/schedule'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { nextFires } from '@/shared/lib/cron'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function SchedulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspace } = await params
  const rawView = (await searchParams).view
  const viewParam = Array.isArray(rawView) ? rawView[0] : rawView
  const initialView = viewParam === 'owner' || viewParam === 'calendar' ? viewParam : 'list'
  const { principal, ctx } = await currentPrincipal()
  const canWrite = can(principal?.roles, 'schedules:write')
  let error: string | undefined
  let schedules = schedulesSchema.parse([])
  try {
    schedules = schedulesSchema.parse(await controlPlane.listSchedules(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 소유자 표기(members 조인)는 부가 정보 — 실패해도 목록 자체는 보인다. (스코어카드 목록과 동일 패턴)
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  // 다음 발사 시각은 서버에서 한 번 계산(now 고정 → 상대 날짜 라벨이 서버/클라 동일, hydration 안전).
  // 일시중지 예약은 발사하지 않으므로 빈 배열. 컨트롤플레인/Temporal 이 실제 발사의 SSOT.
  const now = new Date()
  const nowIso = now.toISOString()
  const fires: Record<string, string[]> = {}
  for (const s of schedules)
    fires[s.id] = s.enabled
      ? nextFires(s.cron, s.timezone, now, { count: 8, horizonDays: 45 }).map((d) => d.toISOString())
      : []

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
        <ScheduleList
          schedules={schedules}
          authors={authors}
          fires={fires}
          nowIso={nowIso}
          me={principal?.subject ?? ''}
          canWrite={canWrite}
          initialView={initialView}
        />
      )}
    </div>
  )
}
