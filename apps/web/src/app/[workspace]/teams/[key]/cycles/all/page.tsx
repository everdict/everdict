import { CycleListView } from '@/widgets/cycle-list'

import { loadTeamScope } from '../../../../team-scope'

export const dynamic = 'force-dynamic'

// 팀의 사이클 전부 — `/{workspace}/teams/ENG/cycles/all`. 랜딩이 지금 돌고 있는 하나를 여는 화면이므로,
// "지난 것까지 훑기"는 자기 주소를 갖는다(스위처의 마지막 줄이 여기로 온다).
export default async function TeamCycleIndexPage({
  params,
}: {
  params: Promise<{ workspace: string; key: string }>
}) {
  const { workspace, key } = await params
  const team = await loadTeamScope({ workspace, slug: key, section: 'cycles' })
  return <CycleListView workspace={workspace} team={team} />
}
