import { notFound, redirect } from 'next/navigation'

import { cycleHref, cycleSchema } from '@/entities/cycle'
import { teamWithSummarySchema } from '@/entities/team'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export const dynamic = 'force-dynamic'

// 사이클의 예전 주소 — `/{workspace}/cycles/<uuid>`. 사이클은 한 팀의 것이므로("Cycle 7"은 그 팀의 일곱
// 번째다) 정식 주소는 팀 아래의 번호(`…/teams/ENG/cycles/7`)이고, 여기는 그리로 넘기는 문만 남는다.
// 이슈 상세가 uuid·소문자 주소를 identifier 로 정규화하는 것과 같은 처리다: 이미 붙여넣어진 링크는 죽지 않고,
// 사람이 복사하는 주소는 한 형태로 모인다.
export default async function LegacyCycleDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const ctx = await authContext()

  const cycle = await controlPlane
    .getCycle(ctx, id)
    .then((r) => cycleSchema.parse(r))
    .catch(() => undefined)
  // 없는 사이클도, 볼 수 없는 팀의 사이클도 같은 답 — 제어 평면이 404 로 답하는 것을 웹이 그대로 옮긴다.
  if (!cycle) notFound()

  const team = await controlPlane
    .getTeam(ctx, cycle.teamId)
    .then((r) => teamWithSummarySchema.parse(r))
    .catch(() => undefined)
  if (!team) notFound()

  redirect(cycleHref(workspace, team.key, cycle.number))
}
