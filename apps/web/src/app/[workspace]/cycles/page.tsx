import { notFound, redirect } from 'next/navigation'

import { teamSectionHref, teamsWithSummarySchema, type TeamWithSummary } from '@/entities/team'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

import { redirectLegacyTeamScope } from '../team-scope'

export const dynamic = 'force-dynamic'

// 사이클에는 워크스페이스 수준의 목록이 없다 — 언제나 한 팀의 이터레이션이고("Cycle 3"은 그 팀의 세 번째다),
// 여러 팀의 것을 한 화면에 섞으면 그 번호가 누구의 것인지 알 수 없다. 그래서 이 주소는 화면이 아니라
// 팀의 사이클 목록으로 가는 문이다: `?team=` 이 있으면 그 팀, 없으면 워크스페이스의 기본 팀.
export default async function CyclesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ team?: string }>
}) {
  const { workspace } = await params
  const search = await searchParams
  await redirectLegacyTeamScope({ workspace, section: 'cycles', search })

  const ctx = await authContext()
  const teams: TeamWithSummary[] = await controlPlane
    .listTeams(ctx)
    .then((r) => teamsWithSummarySchema.parse(r))
    .catch((): TeamWithSummary[] => [])
  // 목록 읽기가 곧 불변식 복구 지점이라 워크스페이스에는 언제나 팀이 하나는 있다. 그래도 팀을 못 읽었으면
  // 갈 곳이 없으므로 404 — 존재하지 않는 목록을 빈 화면으로 흉내 내지 않는다.
  const landing = teams.find((x) => x.isDefault) ?? teams[0]
  if (!landing) notFound()
  redirect(teamSectionHref(workspace, landing.key, 'cycles'))
}
